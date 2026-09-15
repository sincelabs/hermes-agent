/**
 * Analytics — what the agent spent, and on what.
 *
 * `/api/analytics/usage` answers with six things: the per-day series, the
 * per-model split, the per-task split for auxiliary work, the window totals,
 * the tool-call counts and the skill-usage counts. This page used to render
 * three of them, and of the day and model rows it drew only input and output
 * — cache reads, reasoning tokens, API calls and cost arrived on every
 * response and were dropped on the floor. Everything the endpoint returns is
 * on the page now, because a number that is fetched and not shown is a number
 * nobody can act on.
 *
 * Two honesty rules shape the layout.
 *
 * The token and cost figures are a LOCAL DEBUG ESTIMATE and are gated behind
 * `dashboard.show_token_analytics` (default off). They count only successful
 * main-agent responses that carried a usage block, so auxiliary calls,
 * provider retries and cache writes are missing; on a model with heavy
 * auxiliary traffic the local total can be orders of magnitude under what the
 * provider bills. That gate stays exactly as it was.
 *
 * But tool calls and skill usage are not estimates — they are counts of what
 * the agent did, off the session log, with nothing to diverge from. They used
 * to be hidden by the same switch, which meant turning off a warning about
 * token arithmetic also turned off the record of what the agent had been
 * doing. They render either way now, and say why.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Brain,
  Cpu,
  Layers,
  RefreshCw,
  TrendingUp,
  Wrench,
} from "lucide-react";
import { api } from "@/lib/api";
import type {
  AnalyticsResponse,
  AnalyticsAuxTaskEntry,
  AnalyticsDailyEntry,
  AnalyticsModelEntry,
  AnalyticsSkillEntry,
  AnalyticsToolEntry,
} from "@/lib/api";
import { timeAgo } from "@/lib/utils";
import { auxTaskHint, auxTaskLabel } from "@/lib/aux-tasks";
import { Button } from "@nous-research/ui/ui/components/button";
import { Segmented } from "@nous-research/ui/ui/components/segmented";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Stats } from "@nous-research/ui/ui/components/stats";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { usePageHeader } from "@/contexts/usePageHeader";
import { useI18n } from "@/i18n";
import { PluginSlot } from "@/plugins";

const PERIODS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
] as const;

const CHART_HEIGHT_PX = 160;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Matches the Models page: enough decimals to stay non-zero at small spends. */
function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return "—";
}

function formatCount(n: number): string {
  return n >= 10_000 ? formatTokens(n) : String(n);
}

function formatDate(day: string): string {
  try {
    const d = new Date(day + "T00:00:00");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return day;
  }
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function useTableSort<T>(
  data: T[],
  defaultKey: keyof T & string,
  defaultDir: "asc" | "desc" = "desc",
) {
  const [sortKey, setSortKey] = useState<string>(defaultKey);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(defaultDir);

  const sorted = useMemo(() => {
    return [...data].sort((a, b) => {
      const aVal = a[sortKey as keyof T];
      const bVal = b[sortKey as keyof T];
      // Nulls always last regardless of direction
      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;
      if (aVal === bVal) return 0;
      const cmp = aVal > bVal ? 1 : -1;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [data, sortKey, sortDir]);

  const toggle = useCallback(
    (key: string) => {
      if (key === sortKey) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortDir("desc");
      }
    },
    [sortKey],
  );

  return { sorted, sortKey, sortDir, toggle };
}

function SortHeader({
  label,
  col,
  sortKey,
  sortDir,
  toggle,
  className,
}: {
  label: string;
  col: string;
  sortKey: string;
  sortDir: "asc" | "desc";
  toggle: (key: string) => void;
  className?: string;
}) {
  const active = col === sortKey;
  return (
    <th
      onClick={() => toggle(col)}
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
      className={`cursor-pointer select-none ${className ?? ""}`}
    >
      <span className="-mx-1 inline-flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-muted/40">
        {label}
        {active ? (
          sortDir === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5 shrink-0 text-foreground/80" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5 shrink-0 text-foreground/80" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 shrink-0 text-text-tertiary" />
        )}
      </span>
    </th>
  );
}

/**
 * One card frame for every panel on the page, so a section is a title, an
 * icon, one line of explanation and then the data — never a different shape
 * per section.
 */
function Panel({
  icon: Icon,
  title,
  hint,
  aside,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Icon className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
          {aside}
        </div>
        {hint ? (
          <p className="font-mondwest max-w-prose text-xs normal-case text-text-tertiary">{hint}</p>
        ) : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** A table that scrolls sideways rather than crushing its columns on a phone. */
function TableScroll({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="font-mondwest w-full min-w-[34rem] text-sm normal-case">{children}</table>
    </div>
  );
}

const HEAD_ROW = "border-b border-border text-xs text-muted-foreground";
const CELL = "py-2 px-3 text-right";
const ROW = "border-b border-border/50 transition-colors hover:bg-secondary/20";

/**
 * Tokens per day, input stacked on output.
 *
 * Cache reads are deliberately NOT a third segment: they routinely run an
 * order of magnitude above the other two, and stacking them would flatten
 * every real day into the baseline. They are reported as a figure in the
 * summary and as a column in the table instead, where the scale does not
 * have to be shared.
 */
function TokenBarChart({ daily }: { daily: AnalyticsDailyEntry[] }) {
  const { t } = useI18n();
  if (daily.length === 0) return null;

  const maxTokens = Math.max(...daily.map((d) => d.input_tokens + d.output_tokens), 1);

  return (
    <Panel
      icon={BarChart3}
      title={t.analytics.dailyTokenUsage}
      aside={
        <div className="font-mondwest flex items-center gap-4 text-xs normal-case text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5"
              style={{ backgroundColor: "var(--series-input-token)" }}
            />
            {t.analytics.input}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5"
              style={{ backgroundColor: "var(--series-output-token)" }}
            />
            {t.analytics.output}
          </span>
        </div>
      }
    >
      {/* The scale, once, at the top of the plot. A chart whose tallest bar is
          unlabelled is a shape, not a measurement. */}
      <div className="font-mondwest mb-1 text-xs normal-case text-text-tertiary">
        {formatTokens(maxTokens)}
      </div>
      <div className="flex items-end gap-[2px]" style={{ height: CHART_HEIGHT_PX }}>
        {daily.map((d) => {
          const total = d.input_tokens + d.output_tokens;
          const inputH = Math.round((d.input_tokens / maxTokens) * CHART_HEIGHT_PX);
          const outputH = Math.round((d.output_tokens / maxTokens) * CHART_HEIGHT_PX);
          return (
            <div
              key={d.day}
              className="group relative flex min-w-0 flex-1 flex-col justify-end"
              style={{ height: CHART_HEIGHT_PX }}
            >
              {/* Anchored to the bar's own column and clamped inside the plot,
                  so the first and last day's tooltip cannot run off the card. */}
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 group-hover:block">
                <div className="font-mondwest border border-border bg-card px-2.5 py-1.5 text-xs whitespace-nowrap text-foreground normal-case shadow-lg">
                  <div className="font-medium">{formatDate(d.day)}</div>
                  <div>
                    {t.analytics.input}: {formatTokens(d.input_tokens)}
                  </div>
                  <div>
                    {t.analytics.output}: {formatTokens(d.output_tokens)}
                  </div>
                  <div>
                    {t.analytics.total}: {formatTokens(total)}
                  </div>
                  {d.cache_read_tokens > 0 ? (
                    <div className="text-text-tertiary">
                      {t.analytics.cacheReads ?? "Cache Reads"}:{" "}
                      {formatTokens(d.cache_read_tokens)}
                    </div>
                  ) : null}
                  {d.estimated_cost > 0 ? (
                    <div className="text-text-tertiary">
                      {t.analytics.estimatedCost ?? "Est. Cost"}: {formatCost(d.estimated_cost)}
                    </div>
                  ) : null}
                </div>
              </div>

              <div
                className="w-full"
                style={{
                  backgroundColor:
                    "color-mix(in srgb, var(--series-input-token) 70%, transparent)",
                  height: Math.max(inputH, total > 0 ? 1 : 0),
                }}
              />
              <div
                className="w-full"
                style={{
                  backgroundColor:
                    "color-mix(in srgb, var(--series-output-token) 70%, transparent)",
                  height: Math.max(outputH, d.output_tokens > 0 ? 1 : 0),
                }}
              />
            </div>
          );
        })}
      </div>

      <div className="font-mondwest mt-2 flex justify-between text-xs normal-case text-text-tertiary">
        <span>{formatDate(daily[0].day)}</span>
        {daily.length > 2 && <span>{formatDate(daily[Math.floor(daily.length / 2)].day)}</span>}
        <span>{daily.length > 1 ? formatDate(daily[daily.length - 1].day) : ""}</span>
      </div>
    </Panel>
  );
}

function DailyTable({ daily }: { daily: AnalyticsDailyEntry[] }) {
  const { t } = useI18n();
  const { sorted, sortKey, sortDir, toggle } = useTableSort(daily, "day", "desc");
  if (daily.length === 0) return null;

  // Columns for figures the agent never reported stay off the table entirely:
  // a column of dashes reads as data that is missing rather than as a counter
  // this deployment does not keep.
  const hasCache = daily.some((d) => d.cache_read_tokens > 0);
  const hasReasoning = daily.some((d) => d.reasoning_tokens > 0);
  const hasCost = daily.some((d) => d.estimated_cost > 0);
  const head = { sortKey, sortDir, toggle };

  return (
    <Panel icon={TrendingUp} title={t.analytics.dailyBreakdown}>
      <TableScroll>
        <thead>
          <tr className={HEAD_ROW}>
            <SortHeader
              label={t.analytics.date}
              col="day"
              {...head}
              className="py-2 pr-3 text-left font-medium"
            />
            <SortHeader
              label={t.sessions.title}
              col="sessions"
              {...head}
              className={`${CELL} font-medium`}
            />
            <SortHeader
              label={t.analytics.apiCalls}
              col="api_calls"
              {...head}
              className={`${CELL} font-medium`}
            />
            <SortHeader
              label={t.analytics.input}
              col="input_tokens"
              {...head}
              className={`${CELL} font-medium`}
            />
            <SortHeader
              label={t.analytics.output}
              col="output_tokens"
              {...head}
              className={`${CELL} font-medium`}
            />
            {hasCache && (
              <SortHeader
                label={t.analytics.cacheReads ?? "Cache Reads"}
                col="cache_read_tokens"
                {...head}
                className={`${CELL} font-medium`}
              />
            )}
            {hasReasoning && (
              <SortHeader
                label={t.analytics.reasoning ?? "Reasoning"}
                col="reasoning_tokens"
                {...head}
                className={`${CELL} font-medium`}
              />
            )}
            {hasCost && (
              <SortHeader
                label={t.analytics.estimatedCost ?? "Est. Cost"}
                col="estimated_cost"
                {...head}
                className={`${CELL} font-medium`}
              />
            )}
          </tr>
        </thead>
        <tbody>
          {sorted.map((d) => (
            <tr key={d.day} className={ROW}>
              <td className="py-2 pr-3 font-medium">{formatDate(d.day)}</td>
              <td className={`${CELL} text-muted-foreground`}>{d.sessions}</td>
              <td className={`${CELL} text-muted-foreground`}>{formatCount(d.api_calls)}</td>
              <td className={CELL}>
                <span style={{ color: "var(--series-input-token)" }}>
                  {formatTokens(d.input_tokens)}
                </span>
              </td>
              <td className={CELL}>
                <span style={{ color: "var(--series-output-token)" }}>
                  {formatTokens(d.output_tokens)}
                </span>
              </td>
              {hasCache && (
                <td className={`${CELL} text-muted-foreground`}>
                  {formatTokens(d.cache_read_tokens)}
                </td>
              )}
              {hasReasoning && (
                <td className={`${CELL} text-muted-foreground`}>
                  {formatTokens(d.reasoning_tokens)}
                </td>
              )}
              {hasCost && (
                <td className={`${CELL} text-muted-foreground`}>{formatCost(d.estimated_cost)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </TableScroll>
    </Panel>
  );
}

function ModelTable({ models }: { models: AnalyticsModelEntry[] }) {
  const { t } = useI18n();
  const { sorted, sortKey, sortDir, toggle } = useTableSort(models, "input_tokens", "desc");
  if (models.length === 0) return null;

  const hasCost = models.some((m) => m.estimated_cost > 0);
  const head = { sortKey, sortDir, toggle };

  return (
    <Panel icon={Cpu} title={t.analytics.perModelBreakdown}>
      <TableScroll>
        <thead>
          <tr className={HEAD_ROW}>
            <SortHeader
              label={t.analytics.model}
              col="model"
              {...head}
              className="py-2 pr-3 text-left font-medium"
            />
            <SortHeader
              label={t.sessions.title}
              col="sessions"
              {...head}
              className={`${CELL} font-medium`}
            />
            <SortHeader
              label={t.analytics.apiCalls}
              col="api_calls"
              {...head}
              className={`${CELL} font-medium`}
            />
            <SortHeader
              label={t.analytics.tokens}
              col="input_tokens"
              {...head}
              className={`${CELL} font-medium`}
            />
            {hasCost && (
              <SortHeader
                label={t.analytics.estimatedCost ?? "Est. Cost"}
                col="estimated_cost"
                {...head}
                className={`${CELL} font-medium`}
              />
            )}
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => (
            <tr key={m.model} className={ROW}>
              <td className="py-2 pr-3">
                <span className="font-mono-ui text-xs">{m.model}</span>
                {/* A model that also served auxiliary work carries usage the
                    transcript never shows; say which tasks, not just that. */}
                {m.aux_tasks?.length ? (
                  <span className="ml-2 text-xs text-text-tertiary">
                    + {m.aux_tasks.map((a) => auxTaskLabel(a.task)).join(", ")}
                  </span>
                ) : null}
              </td>
              <td className={`${CELL} text-muted-foreground`}>{m.sessions}</td>
              <td className={`${CELL} text-muted-foreground`}>{formatCount(m.api_calls)}</td>
              <td className={CELL}>
                <span style={{ color: "var(--series-input-token)" }}>
                  {formatTokens(m.input_tokens)}
                </span>
                {" / "}
                <span style={{ color: "var(--series-output-token)" }}>
                  {formatTokens(m.output_tokens)}
                </span>
              </td>
              {hasCost && (
                <td className={`${CELL} text-muted-foreground`}>{formatCost(m.estimated_cost)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </TableScroll>
    </Panel>
  );
}

/**
 * What the agent spent outside the conversation.
 *
 * The endpoint has answered with `by_task` ever since auxiliary usage was
 * recorded, and nothing read it — so "what is compression costing me", the
 * question the server-side comment says the field exists to answer, had no
 * answer anywhere in the dashboard.
 */
function AuxTaskTable({ tasks }: { tasks: AnalyticsAuxTaskEntry[] }) {
  const { t } = useI18n();
  const { sorted, sortKey, sortDir, toggle } = useTableSort(tasks, "input_tokens", "desc");
  if (tasks.length === 0) return null;

  const hasCost = tasks.some((task) => task.estimated_cost > 0);
  const head = { sortKey, sortDir, toggle };

  return (
    <Panel
      icon={Layers}
      title={t.analytics.auxiliaryWork ?? "Auxiliary Work"}
      hint={
        t.analytics.auxiliaryWorkHint ??
        "Models the agent calls outside the conversation — compaction, vision, titles. Invisible in the transcript, and often a real share of the bill."
      }
    >
      <TableScroll>
        <thead>
          <tr className={HEAD_ROW}>
            <SortHeader
              label={t.analytics.task ?? "Task"}
              col="task"
              {...head}
              className="py-2 pr-3 text-left font-medium"
            />
            <SortHeader
              label={t.analytics.calls ?? "Calls"}
              col="api_calls"
              {...head}
              className={`${CELL} font-medium`}
            />
            <SortHeader
              label={t.analytics.tokens}
              col="input_tokens"
              {...head}
              className={`${CELL} font-medium`}
            />
            {hasCost && (
              <SortHeader
                label={t.analytics.estimatedCost ?? "Est. Cost"}
                col="estimated_cost"
                {...head}
                className={`${CELL} font-medium`}
              />
            )}
          </tr>
        </thead>
        <tbody>
          {sorted.map((task) => (
            <tr key={task.task} className={ROW}>
              <td className="py-2 pr-3">
                <div className="font-medium">{auxTaskLabel(task.task)}</div>
                <div className="text-xs text-text-tertiary">
                  {[auxTaskHint(task.task), ...(task.models ?? [])].filter(Boolean).join(" · ")}
                </div>
              </td>
              <td className={`${CELL} text-muted-foreground`}>{formatCount(task.api_calls)}</td>
              <td className={CELL}>
                <span style={{ color: "var(--series-input-token)" }}>
                  {formatTokens(task.input_tokens)}
                </span>
                {" / "}
                <span style={{ color: "var(--series-output-token)" }}>
                  {formatTokens(task.output_tokens)}
                </span>
              </td>
              {hasCost && (
                <td className={`${CELL} text-muted-foreground`}>
                  {formatCost(task.estimated_cost)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </TableScroll>
    </Panel>
  );
}

/**
 * The tools the agent reached for, ranked.
 *
 * A count, not an estimate: it comes off the session log's own tool rows, so
 * unlike the token arithmetic there is nothing for it to diverge from. That
 * is why it renders whether or not token analytics are switched on.
 */
function ToolTable({ tools }: { tools: AnalyticsToolEntry[] }) {
  const { t } = useI18n();
  if (tools.length === 0) return null;
  const top = tools.slice(0, 15);
  const peak = Math.max(...top.map((tool) => tool.count), 1);

  return (
    <Panel
      icon={Wrench}
      title={t.analytics.toolCalls ?? "Tool Calls"}
      hint={t.analytics.toolCallsHint ?? "What the agent actually reached for, ranked by how often."}
      aside={
        <span className="font-mondwest text-xs normal-case text-text-tertiary">
          {formatCount(tools.reduce((sum, tool) => sum + tool.count, 0))}
        </span>
      }
    >
      <ul className="flex flex-col gap-2">
        {top.map((tool) => (
          <li
            key={tool.tool}
            className="grid grid-cols-[minmax(6rem,10rem)_1fr_auto] items-center gap-3"
          >
            <span className="font-mono-ui truncate text-xs" title={tool.tool}>
              {tool.tool}
            </span>
            <span className="h-1.5 w-full bg-muted">
              <span
                className="block h-full"
                style={{
                  width: `${Math.max((tool.count / peak) * 100, 2)}%`,
                  backgroundColor: "var(--series-output-token)",
                }}
              />
            </span>
            <span className="font-mondwest text-xs tabular-nums normal-case text-muted-foreground">
              {formatCount(tool.count)}
              <span className="ml-1.5 text-text-tertiary">{tool.percentage.toFixed(0)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function SkillTable({ skills }: { skills: AnalyticsSkillEntry[] }) {
  const { t } = useI18n();
  const { sorted, sortKey, sortDir, toggle } = useTableSort(skills, "total_count", "desc");
  if (skills.length === 0) return null;
  const head = { sortKey, sortDir, toggle };

  return (
    <Panel icon={Brain} title={t.analytics.topSkills}>
      <TableScroll>
        <thead>
          <tr className={HEAD_ROW}>
            <SortHeader
              label={t.analytics.skill}
              col="skill"
              {...head}
              className="py-2 pr-3 text-left font-medium"
            />
            <SortHeader
              label={t.analytics.loads}
              col="view_count"
              {...head}
              className={`${CELL} font-medium`}
            />
            <SortHeader
              label={t.analytics.edits}
              col="manage_count"
              {...head}
              className={`${CELL} font-medium`}
            />
            <SortHeader
              label={t.analytics.total}
              col="total_count"
              {...head}
              className={`${CELL} font-medium`}
            />
            <SortHeader
              label={t.analytics.lastUsed}
              col="last_used_at"
              {...head}
              className={`${CELL} font-medium`}
            />
          </tr>
        </thead>
        <tbody>
          {sorted.map((skill) => (
            <tr key={skill.skill} className={ROW}>
              <td className="py-2 pr-3">
                <span className="font-mono-ui text-xs">{skill.skill}</span>
              </td>
              <td className={`${CELL} text-muted-foreground`}>{skill.view_count}</td>
              <td className={`${CELL} text-muted-foreground`}>{skill.manage_count}</td>
              <td className={CELL}>{skill.total_count}</td>
              <td className={`${CELL} text-muted-foreground`}>
                {skill.last_used_at ? timeAgo(skill.last_used_at) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </TableScroll>
    </Panel>
  );
}

export default function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Gated on `dashboard.show_token_analytics` (default off) — see the module
  // comment. `null` means the config has not answered yet, which is not the
  // same as "off": rendering the explanation card before it answers would
  // flash a warning at every operator who has the switch on.
  const [showTokens, setShowTokens] = useState<boolean | null>(null);
  const { t } = useI18n();
  const { setAfterTitle, setEnd } = usePageHeader();

  useEffect(() => {
    api
      .getConfig()
      .then((cfg) => {
        const dash = (cfg?.dashboard ?? {}) as { show_token_analytics?: unknown };
        setShowTokens(dash.show_token_analytics === true);
      })
      .catch(() => setShowTokens(false));
  }, []);

  // Fetched whichever way the gate is set: the same response carries the tool
  // and skill counts, which the gate has no claim on.
  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getAnalytics(days)
      .then(setData)
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [days]);

  useLayoutEffect(() => {
    // Period + refresh live in afterTitle so the controls sit next to the page
    // title rather than pinned to the far-right `end` slot. One segmented
    // control rather than three buttons: these are three values of one
    // setting, and the control that says so is the one that looks like it.
    setAfterTitle(
      <div className="flex flex-wrap items-center gap-1.5">
        <Segmented
          size="sm"
          value={String(days)}
          options={PERIODS.map((p) => ({ label: p.label, value: String(p.days) }))}
          onChange={(value) => setDays(Number(value))}
        />
        <Button
          type="button"
          ghost
          size="icon"
          className="text-muted-foreground hover:text-foreground"
          onClick={load}
          disabled={loading}
          aria-label={t.common.refresh}
        >
          {loading ? <Spinner /> : <RefreshCw />}
        </Button>
      </div>,
    );
    setEnd(null);
    return () => {
      setAfterTitle(null);
      setEnd(null);
    };
  }, [days, loading, load, setAfterTitle, setEnd, t.common.refresh]);

  useEffect(() => {
    load();
  }, [load]);

  const tools = data?.tools ?? [];
  const skills = data?.skills.top_skills ?? [];
  const nothingRecorded =
    data !== null &&
    data.daily.length === 0 &&
    data.by_model.length === 0 &&
    tools.length === 0 &&
    skills.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <PluginSlot name="analytics:top" />

      {loading && !data && (
        <div className="flex items-center justify-center py-24">
          <Spinner className="text-2xl text-primary" />
        </div>
      )}

      {error && (
        <Card>
          <CardContent className="py-6">
            <p className="text-center text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {showTokens === false && (
        <Card>
          <CardContent className="py-10">
            <div className="mx-auto flex max-w-2xl flex-col gap-3 text-sm text-muted-foreground">
              <h2 className="font-mondwest text-display text-base tracking-wider text-foreground">
                Token analytics hidden
              </h2>
              <p>
                The token, cost, and per-day analytics on this page are a local debug estimate. They
                only count successful main-agent responses with a usable{" "}
                <span className="font-mono">usage</span> block, and silently exclude auxiliary calls
                (context compression, title generation, vision, session search, web extract, smart
                approvals, MCP routing, plugin LLM access) plus provider-side retries and fallback
                attempts. Cache writes are missing entirely.
              </p>
              <p>
                On models with heavy auxiliary traffic (Kimi K2.6, MiniMax M2.7) the local total can
                be 10x–100x lower than what your provider bills. Hiding these numbers is safer than
                letting them look authoritative.
              </p>
              <p>
                Check your provider dashboard (OpenRouter, Anthropic, etc.) for actual usage and
                billing. To re-enable the local debug estimate anyway, set{" "}
                <span className="font-mono">dashboard.show_token_analytics: true</span> in{" "}
                <a href="/config" className="underline">
                  Config
                </a>
                .
              </p>
              <p className="text-text-tertiary">
                {t.analytics.countsOnly ??
                  "Counts of what the agent did. Not token estimates, so these are shown either way."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {showTokens && data && (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardContent className="py-6">
                <Stats
                  items={[
                    {
                      label: t.analytics.totalTokens,
                      value: formatTokens(data.totals.total_input + data.totals.total_output),
                    },
                    { label: t.analytics.input, value: formatTokens(data.totals.total_input) },
                    { label: t.analytics.output, value: formatTokens(data.totals.total_output) },
                    // Fetched on every response since cache accounting landed,
                    // and shown here for the first time: on a cached workload
                    // these two dwarf the pair above them.
                    {
                      label: t.analytics.cacheReads ?? "Cache Reads",
                      value: formatTokens(data.totals.total_cache_read),
                    },
                    {
                      label: t.analytics.reasoning ?? "Reasoning",
                      value: formatTokens(data.totals.total_reasoning),
                    },
                    {
                      label: t.analytics.totalSessions,
                      value: `${data.totals.total_sessions} (~${(data.totals.total_sessions / days).toFixed(1)}${t.analytics.perDayAvg})`,
                    },
                    {
                      label: t.analytics.apiCalls,
                      value: String(
                        data.totals.total_api_calls ??
                          data.daily.reduce((sum, d) => sum + d.sessions, 0),
                      ),
                    },
                    {
                      label: t.analytics.estimatedCost ?? "Est. Cost",
                      value: formatCost(data.totals.total_estimated_cost),
                    },
                  ]}
                />
              </CardContent>
            </Card>

            <TokenBarChart daily={data.daily} />
          </div>

          <DailyTable daily={data.daily} />
          <ModelTable models={data.by_model} />
          <AuxTaskTable tasks={data.by_task ?? []} />
        </>
      )}

      {/* Counts, not estimates — outside the token gate on purpose. */}
      <ToolTable tools={tools} />
      <SkillTable skills={skills} />

      {nothingRecorded && (
        <Card>
          <CardContent className="py-12">
            <div className="flex flex-col items-center text-muted-foreground">
              <BarChart3 className="mb-3 h-8 w-8 opacity-40" />
              <p className="text-sm font-medium">{t.analytics.noUsageData}</p>
              <p className="mt-1 text-xs text-text-tertiary">{t.analytics.startSession}</p>
            </div>
          </CardContent>
        </Card>
      )}
      <PluginSlot name="analytics:bottom" />
    </div>
  );
}
