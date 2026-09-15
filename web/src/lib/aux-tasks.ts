/**
 * The auxiliary task slots, as the agent names them.
 *
 * A "task" here is a job the agent hands to a model that is not the main
 * conversation: compressing context, reading an image, generating a title.
 * They are invisible in the transcript and they are where a surprising share
 * of a bill goes, so both the Models page (which assigns a model to each slot)
 * and the Analytics page (which reports what each slot spent) need the same
 * names for them.
 *
 * Must match `_AUX_TASK_SLOTS` in `hermes_cli/web_server.py`. A slot the
 * server reports that is not listed here still renders — under its own key,
 * never dropped — because a missing label is a gap in this list, not evidence
 * that the usage did not happen.
 */
export interface AuxTaskSlot {
  key: string;
  label: string;
  hint: string;
}

export const AUX_TASKS: readonly AuxTaskSlot[] = [
  { key: "vision", label: "Vision", hint: "Image analysis" },
  { key: "compression", label: "Compression", hint: "Context compaction" },
  { key: "skills_hub", label: "Skills Hub", hint: "Skill search" },
  { key: "approval", label: "Approval", hint: "Smart auto-approve" },
  { key: "mcp", label: "MCP", hint: "MCP tool routing" },
  { key: "title_generation", label: "Title Gen", hint: "Session titles" },
  { key: "review", label: "Review", hint: "/review subagent" },
  { key: "triage_specifier", label: "Triage Specifier", hint: "Kanban spec fleshing" },
  { key: "kanban_decomposer", label: "Kanban Decomposer", hint: "Task decomposition" },
  { key: "profile_describer", label: "Profile Describer", hint: "Auto profile descriptions" },
  { key: "curator", label: "Curator", hint: "Skill-usage review" },
] as const;

const BY_KEY = new Map(AUX_TASKS.map((slot) => [slot.key, slot]));

/** The slot's display name, or the raw key when the server knows a slot we do not. */
export function auxTaskLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? key;
}

/** The one-line explanation of what the slot does, or "" when unknown. */
export function auxTaskHint(key: string): string {
  return BY_KEY.get(key)?.hint ?? "";
}
