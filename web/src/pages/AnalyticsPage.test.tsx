// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getAnalytics: vi.fn(),
  getConfig: vi.fn(),
  getProfiles: vi.fn(),
  getActiveProfile: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
  setManagementProfile: vi.fn(),
  getManagementProfile: vi.fn(() => ""),
}));

let container: HTMLDivElement;
let root: Root;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function waitFor(cond: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

const text = () => container.textContent ?? "";

/**
 * A response shaped like the endpoint's: every key `/api/analytics/usage`
 * actually answers with, including the two it has always sent and nothing
 * used to read.
 */
function usageResponse() {
  return {
    daily: [
      {
        day: "2026-09-13",
        input_tokens: 12_000,
        output_tokens: 3_000,
        cache_read_tokens: 480_000,
        reasoning_tokens: 900,
        estimated_cost: 0.42,
        actual_cost: 0,
        sessions: 4,
        api_calls: 31,
      },
    ],
    by_model: [
      {
        model: "anthropic/claude-opus-4.7",
        input_tokens: 12_000,
        output_tokens: 3_000,
        estimated_cost: 0.42,
        sessions: 4,
        api_calls: 31,
        aux_tasks: [
          {
            task: "compression",
            input_tokens: 5_000,
            output_tokens: 200,
            estimated_cost: 0.02,
            api_calls: 3,
          },
        ],
      },
    ],
    by_task: [
      {
        task: "compression",
        input_tokens: 5_000,
        output_tokens: 200,
        estimated_cost: 0.02,
        api_calls: 3,
        models: ["anthropic/claude-haiku-4-5"],
      },
    ],
    tools: [
      { tool: "shell_exec", count: 42, percentage: 70 },
      { tool: "file_read", count: 18, percentage: 30 },
    ],
    totals: {
      total_input: 12_000,
      total_output: 3_000,
      total_cache_read: 480_000,
      total_reasoning: 900,
      total_estimated_cost: 0.42,
      total_actual_cost: 0,
      total_sessions: 4,
      total_api_calls: 31,
    },
    skills: {
      summary: {
        total_skill_loads: 5,
        total_skill_edits: 1,
        total_skill_actions: 6,
        distinct_skills_used: 2,
      },
      top_skills: [
        {
          skill: "hilma-tender-intel",
          view_count: 5,
          manage_count: 1,
          total_count: 6,
          percentage: 100,
          last_used_at: 1_760_000_000,
        },
      ],
    },
    period_days: 30,
  };
}

async function renderAnalyticsPage(showTokenAnalytics: boolean) {
  apiMocks.getConfig.mockResolvedValue({
    dashboard: { show_token_analytics: showTokenAnalytics },
  });
  apiMocks.getAnalytics.mockResolvedValue(usageResponse());

  const [
    { default: AnalyticsPage },
    { I18nProvider },
    { SystemActionsProvider },
    { ProfileProvider },
    { PageHeaderProvider },
  ] = await Promise.all([
    import("./AnalyticsPage"),
    import("@/i18n"),
    import("@/contexts/SystemActions"),
    import("@/contexts/ProfileProvider"),
    import("@/contexts/PageHeaderProvider"),
  ]);

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <I18nProvider>
        <MemoryRouter>
          <SystemActionsProvider>
            <ProfileProvider>
              <PageHeaderProvider pluginTabs={[]}>
                <AnalyticsPage />
              </PageHeaderProvider>
            </ProfileProvider>
          </SystemActionsProvider>
        </MemoryRouter>
      </I18nProvider>,
    ),
  );
  await waitFor(() => apiMocks.getAnalytics.mock.calls.length > 0);
  await waitFor(() => text().includes("shell_exec"));
}

beforeEach(() => {
  for (const fn of Object.values(apiMocks)) fn.mockReset();
  apiMocks.getProfiles.mockResolvedValue({ profiles: [] });
  apiMocks.getActiveProfile.mockResolvedValue({ current: "default", active: "default" });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal("matchMedia", () => ({
    addEventListener() {},
    matches: false,
    media: "",
    removeEventListener() {},
  }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

describe("AnalyticsPage renders every channel the endpoint answers with", () => {
  it("shows cache reads, reasoning, cost and the per-task auxiliary split", async () => {
    await renderAnalyticsPage(true);

    // Fetched on every response since cache accounting landed; never shown.
    expect(text()).toContain("Cache Reads");
    expect(text()).toContain("480.0K");
    expect(text()).toContain("Reasoning");
    // A cost estimate, formatted like the Models page formats one.
    expect(text()).toContain("$0.42");
    // by_task — "what is compression costing me" had an answer on the wire
    // and no answer on screen.
    expect(text()).toContain("Auxiliary Work");
    expect(text()).toContain("Compression");
    expect(text()).toContain("Context compaction");
    // A model that also served auxiliary work says which task, on its row.
    expect(text()).toContain("anthropic/claude-opus-4.7");
  });

  it("still reports tool and skill counts when token analytics are hidden", async () => {
    await renderAnalyticsPage(false);

    // The gate is about token arithmetic diverging from provider billing, and
    // it still fires: no token, cost or per-model figure is on the page.
    expect(text()).toContain("Token analytics hidden");
    expect(text()).not.toContain("Cache Reads");
    expect(text()).not.toContain("$0.42");
    expect(text()).not.toContain("Auxiliary Work");

    // Tool and skill counts are counts of what the agent did, off the session
    // log, with nothing to diverge from. Hiding them with the token estimate
    // meant switching off a warning about arithmetic also switched off the
    // record of what the agent had been doing.
    expect(text()).toContain("Tool Calls");
    expect(text()).toContain("shell_exec");
    expect(text()).toContain("hilma-tender-intel");
  });

  it("reads the window once per period rather than per gate state", async () => {
    await renderAnalyticsPage(false);
    // The gate used to short-circuit the fetch, so nothing on the page — tool
    // and skill counts included — could be read while it was off.
    expect(apiMocks.getAnalytics).toHaveBeenCalledWith(30);
  });
});
