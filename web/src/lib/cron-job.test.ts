import { describe, expect, it } from "vitest";

import {
  buildCronJobPayload,
  cronErrorText,
  cronJobCounts,
  cronJobHasExecutionContent,
  cronJobFormFromJob,
  cronJobIsTerminal,
  cronJobState,
  cronLastResult,
  filterCronJobs,
  splitCronList,
  type CronJobFormState,
} from "./cron-job";
import type { CronJob } from "./api";

function form(overrides: Partial<CronJobFormState> = {}): CronJobFormState {
  return {
    name: "",
    prompt: "prompt",
    schedule: "every 1h",
    deliver: "local",
    skills: [],
    provider: "",
    model: "",
    base_url: "",
    script: "",
    no_agent: false,
    context_from: "",
    continuity: false,
    enabled_toolsets: [],
    workdir: "",
    ...overrides,
  };
}

describe("splitCronList", () => {
  it("normalizes comma and newline separated cron list fields", () => {
    expect(splitCronList(" web, terminal\nfile ,, ")).toEqual([
      "web",
      "terminal",
      "file",
    ]);
  });
});

describe("buildCronJobPayload", () => {
  it("normalizes list fields and base URLs", () => {
    const payload = buildCronJobPayload(
      form({
        base_url: "https://example.invalid/v1/",
        enabled_toolsets: ["web", ""],
        context_from: "upstream-a\nupstream-b",
      }),
    );

    expect(payload).toMatchObject({
      base_url: "https://example.invalid/v1",
      context_from: ["upstream-a", "upstream-b"],
      enabled_toolsets: ["web"],
    });
  });

  it("stores continuity as the reserved self entry", () => {
    const payload = buildCronJobPayload(
      form({ continuity: true, context_from: "upstream-a" }),
    );

    expect(payload.context_from).toEqual(["upstream-a", "self"]);
  });

  it("continuity off strips any hand-typed self entry", () => {
    const payload = buildCronJobPayload(
      form({ continuity: false, context_from: "SELF\nupstream-a" }),
    );

    expect(payload.context_from).toEqual(["upstream-a"]);
  });

  it("keeps clear operations explicit for update payloads", () => {
    const payload = buildCronJobPayload(form({ schedule: "every 2h" }));

    expect(payload).toMatchObject({
      schedule: "every 2h",
      provider: null,
      model: null,
      base_url: null,
      script: null,
      no_agent: false,
      context_from: null,
      enabled_toolsets: null,
      workdir: null,
    });
  });
});

describe("cronJobHasExecutionContent", () => {
  it("treats a script as execution content for agent-backed cron jobs", () => {
    const payload = buildCronJobPayload(
      form({ prompt: "", skills: [], script: "collect-status.py" }),
    );

    expect(cronJobHasExecutionContent(payload)).toBe(true);
  });

  it("rejects payloads with no prompt, skills, or script", () => {
    const payload = buildCronJobPayload(form({ prompt: "", skills: [], script: "" }));

    expect(cronJobHasExecutionContent(payload)).toBe(false);
  });
});

describe("cronJobFormFromJob", () => {
  it("preserves schedule fallback and editable list fields", () => {
    const job: CronJob = {
      id: "abc",
      enabled: true,
      schedule_display: "every 1h",
      context_from: ["upstream-a", "upstream-b"],
      enabled_toolsets: ["web"],
    };

    expect(cronJobFormFromJob(job)).toMatchObject({
      schedule: "every 1h",
      context_from: "upstream-a\nupstream-b",
      continuity: false,
      enabled_toolsets: ["web"],
    });
  });

  it("splits the stored self entry into the continuity toggle", () => {
    const job: CronJob = {
      id: "abc",
      enabled: true,
      schedule_display: "every 1h",
      context_from: ["self", "upstream-a"],
    };

    expect(cronJobFormFromJob(job)).toMatchObject({
      context_from: "upstream-a",
      continuity: true,
    });
  });

  it("prefers one-shot run_at over the human display string", () => {
    const job: CronJob = {
      id: "once-job",
      enabled: true,
      schedule: {
        kind: "once",
        run_at: "2026-02-03T14:00:00+08:00",
      },
      schedule_display: "once at 2026-02-03 14:00",
    };

    expect(cronJobFormFromJob(job)).toMatchObject({
      schedule: "2026-02-03T14:00:00+08:00",
    });
  });
});

describe("cronLastResult", () => {
  it("renders nothing for a job that never ran", () => {
    expect(cronLastResult({ last_status: null })).toBeNull();
    expect(cronLastResult({ last_status: "" })).toBeNull();
  });

  it("is green for ok with no detail", () => {
    expect(cronLastResult({ last_status: "ok", last_error: null })).toEqual({
      status: "ok",
      tone: "success",
      detail: null,
    });
  });

  it("is amber for delivery_failed and explains it from last_delivery_error", () => {
    // The agent run succeeded (last_error is null for these runs); the reason
    // lives in last_delivery_error. Must never render as green or as "unknown".
    expect(
      cronLastResult({
        last_status: "delivery_failed",
        last_error: null,
        last_delivery_error: "telegram: 502 Bad Gateway",
      }),
    ).toEqual({
      status: "delivery_failed",
      tone: "warning",
      detail: "telegram: 502 Bad Gateway",
    });
  });

  it("is red for error and any unrecognised literal", () => {
    expect(cronLastResult({ last_status: "error", last_error: "boom" })).toEqual({
      status: "error",
      tone: "destructive",
      detail: "boom",
    });
    expect(cronLastResult({ last_status: "something_new" })?.tone).toBe("destructive");
  });

  it("is amber for blocked_config (preflight refused to burn a run)", () => {
    expect(
      cronLastResult({ last_status: "blocked_config", last_error: "missing API key" }),
    ).toEqual({ status: "blocked_config", tone: "warning", detail: "missing API key" });
  });
});

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "cron_1",
    name: "morning-brief",
    prompt: "Summarise the overnight alerts",
    schedule: { kind: "cron", expr: "0 7 * * *", display: "weekdays at 7am" },
    enabled: true,
    state: "scheduled",
    deliver: "local",
    profile: "default",
    ...overrides,
  } as CronJob;
}

describe("cronJobState", () => {
  it("prefers the stored state and falls back to the enabled flag", () => {
    expect(cronJobState(job())).toBe("scheduled");
    expect(cronJobState(job({ state: "paused", enabled: false }))).toBe("paused");
    // A record with no state word but enabled=false is paused, not "disabled":
    // the resume control keys off this, and "disabled" matched nothing.
    expect(cronJobState(job({ state: undefined, enabled: false }))).toBe("paused");
    expect(cronJobState(job({ state: undefined }))).toBe("scheduled");
  });
});

describe("cronJobIsTerminal", () => {
  it("only calls a completed job finished", () => {
    expect(cronJobIsTerminal(job({ state: "completed", enabled: false }))).toBe(true);
    expect(cronJobIsTerminal(job({ state: "paused", enabled: false }))).toBe(false);
    // A recurring job stuck in `error` still has future occurrences.
    expect(cronJobIsTerminal(job({ state: "error" }))).toBe(false);
  });
});

describe("cronJobCounts and filterCronJobs", () => {
  const jobs = [
    job({ id: "a", last_status: "ok" }),
    job({ id: "b", state: "paused", enabled: false, last_status: "error" }),
    job({ id: "c", last_status: "delivery_failed" }),
    job({ id: "d", name: "inbox-sweep", last_status: "ok" }),
  ];

  it("counts what is failing by the last run, not by the job's state", () => {
    // `b` is paused AND failed; `c` ran fine but never delivered. Both count
    // as failing — a report that never arrived is not a success.
    expect(cronJobCounts(jobs)).toEqual({
      all: 4,
      failing: 2,
      scheduled: 3,
      paused: 1,
    });
  });

  it("narrows to a view", () => {
    expect(filterCronJobs(jobs, "failing", "").map((j) => j.id)).toEqual(["b", "c"]);
    expect(filterCronJobs(jobs, "paused", "").map((j) => j.id)).toEqual(["b"]);
    expect(filterCronJobs(jobs, "all", "").length).toBe(4);
  });

  it("searches name, prompt, schedule and skills", () => {
    expect(filterCronJobs(jobs, "all", "INBOX").map((j) => j.id)).toEqual(["d"]);
    expect(filterCronJobs(jobs, "all", "overnight").length).toBe(4);
    expect(filterCronJobs(jobs, "all", "0 7 * *").length).toBe(4);
    expect(filterCronJobs([job({ skills: ["triage"] })], "all", "triage").length).toBe(1);
    expect(filterCronJobs(jobs, "all", "nothing here")).toEqual([]);
  });
});

describe("cronErrorText", () => {
  it("unwraps the agent's own sentence from the thrown envelope", () => {
    // fetchJSON throws `Error("400: <body>")`; interpolating that into a toast
    // produced "Error: Error: 400: {"detail":"…"}" and buried the reason.
    expect(
      cronErrorText(
        new Error('400: {"detail":"Cannot resume: one-shot time is in the past"}'),
      ),
    ).toBe("Cannot resume: one-shot time is in the past");
  });

  it("joins FastAPI validation errors", () => {
    expect(
      cronErrorText(new Error('422: {"detail":[{"loc":["body"],"msg":"field required"}]}')),
    ).toBe("field required");
  });

  it("falls back to the raw body when it is not JSON", () => {
    expect(cronErrorText(new Error("502: Bad Gateway"))).toBe("Bad Gateway");
    expect(cronErrorText("tunnel closed")).toBe("tunnel closed");
  });
});
