import type { CronJob, CronJobMutation } from "./api";

export interface CronJobFormState {
  name: string;
  prompt: string;
  schedule: string;
  deliver: string;
  skills: string[];
  provider: string;
  model: string;
  base_url: string;
  script: string;
  no_agent: boolean;
  context_from: string;
  continuity: boolean;
  enabled_toolsets: string[];
  workdir: string;
}

/** Split a comma/newline list (or array) into trimmed, non-empty items. */
export function splitCronList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]/)
      : [];
  return items.map((item) => String(item).trim()).filter(Boolean);
}

/** Trim to a non-empty string, or null. Optionally strip trailing slashes
 * (base URLs). Mirrors the backend's `_cron_optional_text`. */
function optionalText(value: string, stripTrailingSlash = false): string | null {
  const text = stripTrailingSlash ? value.trim().replace(/\/+$/, "") : value.trim();
  return text || null;
}

/** Read a stored string field as a plain string ("" when absent). */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Build the create/update payload. Optional fields collapse to null so an
 * update explicitly clears them rather than leaving stale values. */
export function buildCronJobPayload(form: CronJobFormState): CronJobMutation {
  // The `continuity` toggle is stored as the reserved "self" entry in
  // context_from (the job's own previous output). Users never type "self" —
  // the checkbox is the surface; strip any hand-typed variant first.
  const contextFrom = splitCronList(form.context_from).filter(
    (item) => item.toLowerCase() !== "self",
  );
  if (form.continuity) contextFrom.push("self");
  const enabledToolsets = form.enabled_toolsets.filter(Boolean);
  return {
    name: form.name.trim(),
    prompt: form.prompt.trim(),
    schedule: form.schedule.trim(),
    deliver: form.deliver.trim() || "local",
    skills: form.skills.filter(Boolean),
    provider: optionalText(form.provider),
    model: optionalText(form.model),
    base_url: optionalText(form.base_url, true),
    script: optionalText(form.script),
    no_agent: Boolean(form.no_agent),
    context_from: contextFrom.length > 0 ? contextFrom : null,
    enabled_toolsets: enabledToolsets.length > 0 ? enabledToolsets : null,
    workdir: optionalText(form.workdir),
  };
}

export function cronJobHasExecutionContent(
  job: Pick<CronJobMutation, "prompt" | "skills" | "script">,
): boolean {
  const skills = Array.isArray(job.skills) ? job.skills.filter(Boolean) : [];
  return Boolean(asString(job.prompt).trim() || asString(job.script).trim() || skills.length);
}

export function cronJobFormFromJob(job: CronJob): CronJobFormState {
  const storedRefs = splitCronList(job.context_from);
  // Raw store records carry the reserved "self" entry inside context_from;
  // tool/RPC-formatted records strip it and set an explicit continuity flag.
  const continuity =
    Boolean((job as { continuity?: boolean }).continuity) ||
    storedRefs.some((item) => item.toLowerCase() === "self");
  const externalRefs = storedRefs.filter((item) => item.toLowerCase() !== "self");
  return {
    name: asString(job.name),
    prompt: asString(job.prompt),
    schedule:
      asString(job.schedule?.expr) ||
      asString(job.schedule?.run_at) ||
      asString(job.schedule_display),
    deliver: asString(job.deliver) || "local",
    skills: Array.isArray(job.skills) ? job.skills.filter(Boolean) : [],
    provider: asString(job.provider),
    model: asString(job.model),
    base_url: asString(job.base_url),
    script: asString(job.script),
    no_agent: Boolean(job.no_agent),
    context_from: externalRefs.join("\n"),
    continuity,
    enabled_toolsets: splitCronList(job.enabled_toolsets),
    workdir: asString(job.workdir),
  };
}

/** How a job's `last_status` should render. The scheduler writes a small,
 *  closed set of literals; every literal maps to an explicit tone here so a
 *  new status can never fall through to a neutral "unknown"-looking badge.
 *  In particular `delivery_failed` (agent run succeeded, output never reached
 *  the target) is amber, not green and not the same red as a run error, and
 *  its detail lives in `last_delivery_error` (last_error is null for it). */
export type CronLastResultTone = "success" | "warning" | "destructive";

export interface CronLastResult {
  status: string;
  tone: CronLastResultTone;
  /** Human detail to show next to the badge; null when nothing to add. */
  detail: string | null;
}

const CRON_LAST_RESULT_TONE: Record<string, CronLastResultTone> = {
  ok: "success",
  delivery_failed: "warning",
  blocked_config: "warning",
  error: "destructive",
};

export function cronLastResult(
  job: Pick<CronJob, "last_status" | "last_error" | "last_delivery_error">,
): CronLastResult | null {
  const status = asString(job.last_status).trim();
  if (!status) return null;
  const tone = CRON_LAST_RESULT_TONE[status] ?? "destructive";
  if (status === "ok") return { status, tone, detail: null };
  const detail =
    status === "delivery_failed"
      ? asString(job.last_delivery_error).trim() || asString(job.last_error).trim()
      : asString(job.last_error).trim() || asString(job.last_delivery_error).trim();
  return { status, tone, detail: detail || null };
}

/**
 * The job's lifecycle word, derived the way the backend derives it.
 *
 * `enabled` is authoritative for whether the scheduler will fire the job;
 * `state` carries the reason. A record that says neither is scheduled.
 */
export function cronJobState(job: Pick<CronJob, "state" | "enabled">): string {
  return asString(job.state) || (job.enabled === false ? "paused" : "scheduled");
}

/**
 * A job with no occurrence left. Neither Run nor Resume can do anything with
 * one, so both are offered as disabled rather than as buttons that 409.
 */
export function cronJobIsTerminal(job: Pick<CronJob, "state" | "enabled">): boolean {
  return cronJobState(job) === "completed";
}

/** The views the list can be narrowed to, in the order they are offered. */
export type CronJobView = "all" | "failing" | "scheduled" | "paused";

export interface CronJobCounts {
  all: number;
  failing: number;
  scheduled: number;
  paused: number;
}

/** True when the job's LAST RUN went wrong — not the same as its state. */
function cronJobFailed(job: CronJob): boolean {
  const result = cronLastResult(job);
  return (result !== null && result.status !== "ok") || Boolean(job.last_fire_error?.detail);
}

export function cronJobCounts(jobs: readonly CronJob[]): CronJobCounts {
  return {
    all: jobs.length,
    failing: jobs.filter(cronJobFailed).length,
    scheduled: jobs.filter((j) => cronJobState(j) === "scheduled").length,
    paused: jobs.filter((j) => cronJobState(j) === "paused").length,
  };
}

/** The rows a view and a search box leave standing. */
export function filterCronJobs(
  jobs: readonly CronJob[],
  view: CronJobView,
  query: string,
): CronJob[] {
  const q = query.trim().toLowerCase();
  return jobs.filter((job) => {
    if (view === "failing" && !cronJobFailed(job)) return false;
    if (view === "scheduled" && cronJobState(job) !== "scheduled") return false;
    if (view === "paused" && cronJobState(job) !== "paused") return false;
    if (!q) return true;
    return [
      asString(job.name),
      asString(job.prompt),
      asString(job.script),
      asString(job.id),
      asString(job.profile) || asString(job.profile_name),
      asString(job.schedule_display) || asString(job.schedule?.display),
      asString(job.schedule?.expr),
      ...(Array.isArray(job.skills) ? job.skills : []),
    ].some((field) => field.toLowerCase().includes(q));
  });
}

/**
 * What a failed request actually said.
 *
 * `fetchJSON` throws `Error("400: {\"detail\":\"…\"}")`, so interpolating the
 * error into a toast produced "Error: Error: 400: {"detail":"…"}" and buried
 * the one sentence the operator needed — which the backend is at pains to
 * supply for a refused resume or a job that has already finished.
 */
export function cronErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const match = /^(\d{3}):\s*([\s\S]*)$/.exec(raw.trim());
  const body = match ? match[2].trim() : raw;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const detail = (parsed as { detail?: unknown }).detail;
      if (typeof detail === "string" && detail.trim()) return detail.trim();
      // FastAPI's validation errors are a list of {loc, msg}.
      if (Array.isArray(detail)) {
        const msgs = detail
          .map((item) =>
            item && typeof item === "object" ? String((item as { msg?: unknown }).msg ?? "") : "",
          )
          .filter(Boolean);
        if (msgs.length) return msgs.join("; ");
      }
      if (detail && typeof detail === "object") {
        const message = (detail as { message?: unknown }).message;
        if (typeof message === "string" && message.trim()) return message.trim();
      }
    }
  } catch {
    /* not JSON — the raw body is the best we have */
  }
  return body || raw;
}
