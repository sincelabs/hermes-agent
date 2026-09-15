import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type CronTriggerController,
  createCronTriggerController,
} from "@hermes/shared";
import { Pause, Pencil, Play, Trash2, Zap } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Select, SelectOption } from "@nous-research/ui/ui/components/select";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { api } from "@/lib/api";
import type {
  CronJob,
  CronDeliveryTarget,
  ModelOptionsResponse,
  ProfileInfo,
  SkillInfo,
  ToolsetInfo,
} from "@/lib/api";
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
  type CronJobFormState,
  type CronJobView,
} from "@/lib/cron-job";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import {
  DEFAULT_SCHEDULE_STATE,
  ScheduleBuilder,
} from "@/components/ScheduleBuilder";
import {
  buildScheduleString,
  describeSchedule,
  englishOrdinal,
  parseScheduleString,
  type ScheduleBuilderState,
  type ScheduleDescribeStrings,
} from "@/lib/schedule";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { useConfirmDelete } from "@nous-research/ui/hooks/use-confirm-delete";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@nous-research/ui/ui/components/dialog";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { useI18n } from "@/i18n";
import { usePageHeader } from "@/contexts/usePageHeader";
import { PluginSlot } from "@/plugins";
import { Segmented } from "@nous-research/ui/ui/components/segmented";
import { AutomationBlueprints } from "@/components/AutomationBlueprints";
import { cn } from "@/lib/utils";

function formatTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength
    ? value.slice(0, maxLength) + "..."
    : value;
}

function getJobPrompt(job: CronJob): string {
  return asText(job.prompt);
}

function NameCheckboxPicker({
  id,
  available,
  selected,
  onChange,
  emptyLabel,
}: {
  id: string;
  available: Array<{ name: string; description?: string | null }>;
  selected: string[];
  onChange: (names: string[]) => void;
  emptyLabel: string;
}) {
  const names = available.map((item) => item.name);
  const orphaned = selected.filter((s) => !names.includes(s));
  const all = [...orphaned.map((name) => ({ name, description: "" })), ...available];

  if (all.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
  }

  const toggle = (name: string, checked: boolean) => {
    if (checked) onChange([...selected, name]);
    else onChange(selected.filter((s) => s !== name));
  };

  return (
    <div
      id={id}
      className="max-h-36 overflow-y-auto border border-border bg-background/40 p-1"
    >
      {all.map((item) => (
        <label
          key={item.name}
          className="flex cursor-pointer items-center gap-2 px-2 py-1 text-xs hover:bg-muted/40"
          title={item.description || undefined}
        >
          <input
            type="checkbox"
            className="accent-foreground"
            checked={selected.includes(item.name)}
            onChange={(e) => toggle(item.name, e.target.checked)}
          />
          <span className="font-mono-ui truncate">{item.name}</span>
        </label>
      ))}
    </div>
  );
}

interface CronJobEditorState extends CronJobFormState {
  scheduleState: ScheduleBuilderState;
}

interface CronJobFormResources {
  availableSkills: SkillInfo[];
  availableToolsets: ToolsetInfo[];
  modelOptions: ModelOptionsResponse | null;
  deliveryTargets: CronDeliveryTarget[];
}

function emptyCronJobForm(): CronJobEditorState {
  return {
    name: "",
    prompt: "",
    schedule: "",
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
    scheduleState: { ...DEFAULT_SCHEDULE_STATE },
  };
}

function editorFormFromJob(job: CronJob): CronJobEditorState {
  const form = cronJobFormFromJob(job);
  return { ...form, scheduleState: parseScheduleString(form.schedule) };
}

function buildCronJobPayloadFromEditor(form: CronJobEditorState) {
  const { scheduleState, ...payloadForm } = form;
  return buildCronJobPayload({
    ...payloadForm,
    schedule: buildScheduleString(scheduleState),
  });
}

function selectOptions(
  current: string,
  options: Array<{ value: string; label: string }>,
) {
  const known = new Set(options.map((option) => option.value));
  return [
    ...options.map((option) => (
      <SelectOption key={option.value} value={option.value}>
        {option.label}
      </SelectOption>
    )),
    ...(current && !known.has(current)
      ? [
          <SelectOption key={current} value={current}>
            {current}
          </SelectOption>,
        ]
      : []),
  ];
}

function CronAdvancedFields({
  idPrefix,
  form,
  onChange,
  modelOptions,
  availableToolsets,
}: {
  idPrefix: string;
  form: CronJobEditorState;
  onChange: (form: CronJobEditorState) => void;
  modelOptions: ModelOptionsResponse | null;
  availableToolsets: ToolsetInfo[];
}) {
  const update = <K extends keyof CronJobEditorState,>(
    key: K,
    next: CronJobEditorState[K],
  ) => {
    onChange({ ...form, [key]: next });
  };

  const providers = (modelOptions?.providers ?? []).filter(
    (p) => p.authenticated !== false,
  );
  const selectedProvider = providers.find((p) => p.slug === form.provider);
  const models = selectedProvider?.models ?? [];

  return (
    <details className="border border-border bg-background/30 p-3" open>
      <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Advanced fields
      </summary>
      <div className="mt-3 grid gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="grid gap-1">
            <Label htmlFor={`${idPrefix}-provider`}>Provider</Label>
            <Select
              id={`${idPrefix}-provider`}
              value={form.provider}
              onValueChange={(v) => {
                onChange({ ...form, provider: v, model: "" });
              }}
            >
              <SelectOption value="">Default</SelectOption>
              {selectOptions(
                form.provider,
                providers.map((p) => ({ value: p.slug, label: p.name })),
              )}
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${idPrefix}-model`}>Model</Label>
            <Select
              id={`${idPrefix}-model`}
              value={form.model}
              onValueChange={(v) => update("model", v)}
            >
              <SelectOption value="">Default</SelectOption>
              {selectOptions(
                form.model,
                models.map((model) => ({ value: model, label: model })),
              )}
            </Select>
          </div>
        </div>

        <div className="grid gap-1">
          <Label htmlFor={`${idPrefix}-base-url`}>Base URL override</Label>
          <Input
            id={`${idPrefix}-base-url`}
            placeholder="https://api.example.com/v1"
            value={form.base_url}
            onChange={(e) => update("base_url", e.target.value)}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="accent-foreground"
              checked={form.no_agent}
              onChange={(e) => update("no_agent", e.target.checked)}
            />
            no_agent: run the script only and deliver stdout verbatim
          </label>
          <div className="grid gap-1">
            <Label htmlFor={`${idPrefix}-script`}>Script</Label>
            <Input
              id={`${idPrefix}-script`}
              value={form.script}
              onChange={(e) => update("script", e.target.value)}
              placeholder="relative/path/in/scripts"
            />
          </div>
        </div>

        <div className="grid gap-1">
          <Label htmlFor={`${idPrefix}-workdir`}>Workdir</Label>
          <Input
            id={`${idPrefix}-workdir`}
            value={form.workdir}
            onChange={(e) => update("workdir", e.target.value)}
            placeholder="/absolute/project/path"
          />
        </div>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="accent-foreground"
            checked={form.continuity}
            onChange={(e) => update("continuity", e.target.checked)}
          />
          continuity: each run sees the previous run&apos;s output (dedupe, pick up where it left off)
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="grid gap-1">
            <Label htmlFor={`${idPrefix}-context-from`}>context_from job IDs</Label>
            <textarea
              id={`${idPrefix}-context-from`}
              className="flex min-h-[64px] w-full border border-border bg-background/40 px-3 py-2 text-xs font-courier shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30 focus-visible:border-foreground/25"
              placeholder="one job id per line"
              value={form.context_from}
              onChange={(e) => update("context_from", e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${idPrefix}-toolsets`}>enabled_toolsets</Label>
            <NameCheckboxPicker
              id={`${idPrefix}-toolsets`}
              available={availableToolsets}
              selected={form.enabled_toolsets}
              onChange={(v) => update("enabled_toolsets", v)}
              emptyLabel="No toolsets available."
            />
          </div>
        </div>
      </div>
    </details>
  );
}

interface CronJobFormFieldsProps {
  idPrefix: string;
  autoFocus?: boolean;
  form: CronJobEditorState;
  resources: CronJobFormResources;
  onChange: (form: CronJobEditorState) => void;
}

function CronJobFormFields({
  idPrefix,
  autoFocus,
  form,
  resources,
  onChange,
}: CronJobFormFieldsProps) {
  const { t } = useI18n();
  const { availableSkills, availableToolsets, deliveryTargets, modelOptions } = resources;
  const update = <K extends keyof CronJobEditorState,>(
    key: K,
    next: CronJobEditorState[K],
  ) => {
    onChange({ ...form, [key]: next });
  };
  const onlyLocalAvailable =
    deliveryTargets.filter((target) => target.id !== "local").length === 0;

  const deliveryOptions = selectOptions(
    form.deliver,
    deliveryTargets.map((target) => {
      const base = target.id === "local" ? t.cron.delivery.local : target.name;
      if (target.id !== "local" && !target.home_target_set) {
        const hint = t.cron.delivery.needsHomeChannel ?? "set a home channel first";
        return { value: target.id, label: `${base} — ${hint}` };
      }
      return { value: target.id, label: base };
    }),
  );

  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-name`}>{t.cron.nameOptional}</Label>
        <Input
          id={`${idPrefix}-name`}
          autoFocus={autoFocus}
          placeholder={t.cron.namePlaceholder}
          value={form.name}
          onChange={(e) => update("name", e.target.value)}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-prompt`}>{t.cron.prompt}</Label>
        <textarea
          id={`${idPrefix}-prompt`}
          className="flex min-h-[80px] w-full border border-border bg-background/40 px-3 py-2 text-sm font-courier shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30 focus-visible:border-foreground/25"
          placeholder={t.cron.promptPlaceholder}
          value={form.prompt}
          onChange={(e) => update("prompt", e.target.value)}
        />
      </div>

      <ScheduleBuilder
        value={form.scheduleState}
        onChange={(state) => update("scheduleState", state)}
      />

      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-deliver`}>{t.cron.deliverTo}</Label>
        <Select
          id={`${idPrefix}-deliver`}
          value={form.deliver}
          onValueChange={(v) => update("deliver", v)}
        >
          {deliveryOptions}
        </Select>
        {onlyLocalAvailable && (
          <p className="text-xs text-muted-foreground">
            {t.cron.delivery.noneConfigured ??
              "No messaging platforms configured. Set one up under Channels to deliver reports."}
          </p>
        )}
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-skills`}>Skills (optional)</Label>
        <NameCheckboxPicker
          id={`${idPrefix}-skills`}
          available={availableSkills}
          selected={form.skills}
          onChange={(skills) => update("skills", skills)}
          emptyLabel="No skills installed for this profile."
        />
        <p className="text-xs text-muted-foreground">
          Selected skills are loaded before the prompt runs — the cron
          sets when, the skill sets how.
        </p>
      </div>

      <CronAdvancedFields
        idPrefix={`${idPrefix}-advanced`}
        form={form}
        onChange={onChange}
        modelOptions={modelOptions}
        availableToolsets={availableToolsets}
      />
    </>
  );
}

function getJobName(job: CronJob): string {
  return asText(job.name).trim();
}

function getJobTitle(job: CronJob): string {
  const name = getJobName(job);
  if (name) return name;

  const prompt = getJobPrompt(job);
  if (prompt) return truncateText(prompt, 60);

  const script = asText(job.script);
  if (script) return truncateText(script, 60);

  return job.id || "Cron job";
}

function getJobScheduleDisplay(
  job: CronJob,
  strings: ScheduleDescribeStrings,
): string {
  // Prefer a structured render so cron expressions like
  // ``30 14 * * 1,3,5`` surface as "Weekly on Mon, Wed, Fri at 14:30"
  // in the list instead of the raw five-field gibberish. Falls back
  // through the existing chain (``schedule_display`` from the backend,
  // then the structured ``display`` field, then the raw ``expr``) so
  // legacy job rows still render *something* meaningful.
  return describeSchedule(
    job.schedule,
    asText(job.schedule_display) || asText(job.schedule?.display),
    strings,
  );
}

function getRepeatDisplay(job: CronJob): string {
  const repeat = job.repeat;
  if (!repeat || repeat.times == null) return "forever";
  const completed = repeat.completed ?? 0;
  return completed > 0 ? `${completed}/${repeat.times}` : `${repeat.times} times`;
}

function getJobMode(job: CronJob): string {
  if (job.no_agent) return "no_agent";
  if (job.script) return "script+agent";
  return "agent";
}

function getModelDisplay(job: CronJob): string {
  const provider = asText(job.provider);
  const model = asText(job.model);
  if (provider && model) return `${provider}/${model}`;
  return model || provider;
}

function getJobProfile(job: CronJob): string {
  return asText(job.profile) || asText(job.profile_name) || "default";
}

function getJobKey(job: CronJob): string {
  return `${getJobProfile(job)}:${job.id}`;
}

function splitJobKey(key: string): { profile: string; id: string } {
  const idx = key.indexOf(":");
  if (idx === -1) return { profile: "default", id: key };
  return { profile: key.slice(0, idx) || "default", id: key.slice(idx + 1) };
}

function profileLabel(profile: string): string {
  return profile === "default" ? "default" : profile;
}

const STATUS_TONE: Record<string, "success" | "warning" | "destructive"> = {
  enabled: "success",
  scheduled: "success",
  paused: "warning",
  error: "destructive",
  completed: "secondary" as never,
};

/**
 * One count that is also the filter for it.
 *
 * A number an operator cannot act on is decoration. These are the four
 * questions the page gets opened with, and clicking one is how you answer it —
 * so there is no separate dropdown repeating the same four words.
 */
function CountFilter({
  label,
  count,
  tone,
  active,
  onClick,
}: {
  label: string;
  count: number;
  tone: "neutral" | "success" | "warning" | "destructive";
  active: boolean;
  onClick: () => void;
}) {
  const accent =
    count === 0 || tone === "neutral"
      ? "text-foreground"
      : tone === "destructive"
        ? "text-destructive"
        : tone === "warning"
          ? "text-warning"
          : "text-success";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex min-w-[6.5rem] flex-1 flex-col items-start gap-1 border px-3 py-2 text-left transition-colors",
        active
          ? "border-foreground/40 bg-muted/40"
          : "border-border bg-background/40 hover:bg-muted/20",
      )}
    >
      <span className="font-mono-ui text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <span className={cn("font-mono-ui text-lg leading-none tabular-nums", accent)}>
        {count}
      </span>
    </button>
  );
}

/** A small muted fact in a job row's metadata line. */
function Meta({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span className="truncate" title={title}>
      {children}
    </span>
  );
}

export default function CronPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [triggeringJobKeys, setTriggeringJobKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const triggerControllerRef = useRef<CronTriggerController | null>(null);

  useEffect(() => {
    const controller = createCronTriggerController((key, running) => {
      if (triggerControllerRef.current !== controller) return;
      setTriggeringJobKeys((current) => {
        const next = new Set(current);
        if (running) next.add(key);
        else next.delete(key);
        return next;
      });
    });
    triggerControllerRef.current = controller;

    return () => {
      triggerControllerRef.current = null;
    };
  }, []);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("all");
  const [view, setView] = useState<"jobs" | "blueprints">("jobs");
  const [listView, setListView] = useState<CronJobView>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Which row is mid-pause/resume, so only that row's control goes quiet. */
  const [stateChangeKeys, setStateChangeKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const { toast, showToast } = useToast();
  const { t, locale } = useI18n();
  const { setEnd } = usePageHeader();

  // Translation surface for the human-readable schedule describer.
  // English ordinals are a special case ("1st", "2nd", "23rd"); every
  // other locale falls back to the plain numeric form, which avoids
  // shipping incorrect grammar (e.g. naive "1th"/"2th" suffixes that
  // don't exist in most languages).
  //
  // Built inline (not memoized) — the cron page renders a small job
  // list, this is single-digit microseconds, and a useMemo here would
  // just add boilerplate.
  const scheduleDescribeStrings: ScheduleDescribeStrings = {
    ...t.cron.scheduleDescribe,
    weekdaysShort: t.cron.scheduleModes.weekdaysShort,
    ordinal: locale === "en" ? englishOrdinal : (n: number) => String(n),
  };

  // New job modal state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createProfile, setCreateProfile] = useState("default");
  const [createForm, setCreateForm] = useState<CronJobEditorState>(
    emptyCronJobForm,
  );
  const [deliveryTargets, setDeliveryTargets] = useState<CronDeliveryTarget[]>([
    { id: "local", name: "Local", home_target_set: true, home_env_var: null },
  ]);
  const [creating, setCreating] = useState(false);

  // Edit job modal state
  const [editJob, setEditJob] = useState<CronJob | null>(null);
  const [editForm, setEditForm] = useState<CronJobEditorState>(
    emptyCronJobForm,
  );
  const [saving, setSaving] = useState(false);

  // Skills installed in the profile a job will run under, for the
  // attach-skill selector (parity with `hermes cron edit --add-skill`).
  // Keyed on the create-modal profile; the edit modal reuses the list —
  // a job's current skills are always shown even if not in it.
  const [availableSkills, setAvailableSkills] = useState<SkillInfo[]>([]);
  const [availableToolsets, setAvailableToolsets] = useState<ToolsetInfo[]>([]);
  const [modelOptions, setModelOptions] = useState<ModelOptionsResponse | null>(null);

  const resourceProfile = editJob ? getJobProfile(editJob) : createProfile;

  const openEditModal = useCallback((job: CronJob) => {
    setEditJob(job);
    setEditForm(editorFormFromJob(job));
  }, []);

  const selectedProfileRef = useRef(selectedProfile);
  const jobsRequestGenerationRef = useRef(0);
  const jobsActiveRef = useRef(false);

  const loadJobs = useCallback((profile: string) => {
    if (!jobsActiveRef.current || selectedProfileRef.current !== profile) return;

    const generation = ++jobsRequestGenerationRef.current;

    api
      .getCronJobs(profile)
      .then((nextJobs) => {
        if (
          jobsRequestGenerationRef.current === generation &&
          selectedProfileRef.current === profile
        ) {
          setJobs(nextJobs);
          setLoadError(null);
        }
      })
      .catch((e) => {
        if (
          jobsRequestGenerationRef.current === generation &&
          selectedProfileRef.current === profile
        ) {
          // The failure used to be toasted as the word "Loading", which told
          // an operator nothing and vanished. It belongs on the page, with
          // what the agent actually said.
          setLoadError(cronErrorText(e));
        }
      })
      .finally(() => {
        if (
          jobsRequestGenerationRef.current === generation &&
          selectedProfileRef.current === profile
        ) setLoading(false);
      });
  }, []);

  useEffect(() => {
    api
      .getProfiles()
      .then((res) => setProfiles(res.profiles))
      .catch(() => setProfiles([]));
  }, []);

  useEffect(() => {
    api
      .getCronDeliveryTargets()
      .then((res) => setDeliveryTargets(res.targets))
      .catch(() =>
        // Fall back to local-only so the modal still works if the endpoint fails.
        setDeliveryTargets([
          { id: "local", name: "Local", home_target_set: true, home_env_var: null },
        ]),
      );
  }, []);

  useEffect(() => {
    jobsActiveRef.current = true;
    selectedProfileRef.current = selectedProfile;
    loadJobs(selectedProfile);

    return () => {
      jobsActiveRef.current = false;
      jobsRequestGenerationRef.current += 1;
    };
  }, [loadJobs, selectedProfile]);

  // Load resources from the profile the create/edit form actually targets.
  // Pass "default" explicitly so the global dashboard profile switch cannot
  // redirect a default-profile cron form to some other profile.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.getSkills(resourceProfile).catch(() => []),
      api.getToolsets(resourceProfile).catch(() => []),
      api.getModelOptions(resourceProfile).catch(() => null),
    ]).then(([skills, toolsets, options]) => {
      if (cancelled) return;
      setAvailableSkills([...skills].sort((a, b) => a.name.localeCompare(b.name)));
      setAvailableToolsets([...toolsets].sort((a, b) => a.name.localeCompare(b.name)));
      setModelOptions(options);
    });
    return () => {
      cancelled = true;
    };
  }, [resourceProfile]);

  const handleCreate = async () => {
    const payload = buildCronJobPayloadFromEditor(createForm);
    if (
      !payload.schedule ||
      (!payload.no_agent && !cronJobHasExecutionContent(payload))
    ) {
      showToast(`${t.cron.prompt} & ${t.cron.schedule} required`, "error");
      return;
    }
    if (payload.no_agent && !payload.script) {
      showToast("no_agent jobs require a script", "error");
      return;
    }
    setCreating(true);
    try {
      await api.createCronJob(payload, createProfile);
      showToast(t.common.create + " ✓", "success");
      setCreateForm(emptyCronJobForm());
      setCreateModalOpen(false);
      loadJobs(selectedProfile);
    } catch (e) {
      showToast(`${t.config.failedToSave}: ${cronErrorText(e)}`, "error");
    } finally {
      setCreating(false);
    }
  };

  const handleEdit = async () => {
    if (!editJob) return;
    const payload = buildCronJobPayloadFromEditor(editForm);
    if (
      !payload.schedule ||
      (!payload.no_agent && !cronJobHasExecutionContent(payload))
    ) {
      showToast(`${t.cron.prompt} & ${t.cron.schedule} required`, "error");
      return;
    }
    if (payload.no_agent && !payload.script) {
      showToast("no_agent jobs require a script", "error");
      return;
    }
    setSaving(true);
    try {
      await api.updateCronJob(
        editJob.id,
        payload,
        getJobProfile(editJob),
      );
      showToast("Saved changes ✓", "success");
      setEditJob(null);
      loadJobs(selectedProfile);
    } catch (e) {
      showToast(`${t.config.failedToSave}: ${cronErrorText(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const handlePauseResume = async (job: CronJob) => {
    const jobKey = getJobKey(job);
    if (stateChangeKeys.has(jobKey)) return;
    setStateChangeKeys((keys) => new Set(keys).add(jobKey));
    try {
      const isPaused = cronJobState(job) === "paused";
      const profile = getJobProfile(job);
      if (isPaused) {
        await api.resumeCronJob(job.id, profile);
        showToast(
          `${t.cron.resume}: "${truncateText(getJobTitle(job), 30)}"`,
          "success",
        );
      } else {
        await api.pauseCronJob(job.id, profile);
        showToast(
          `${t.cron.pause}: "${truncateText(getJobTitle(job), 30)}"`,
          "success",
        );
      }
      loadJobs(selectedProfile);
    } catch (e) {
      // A refused resume ("one-shot time is in the past") is a sentence worth
      // reading, and the backend supplies it. Show that, not the raw envelope.
      showToast(cronErrorText(e), "error");
    } finally {
      setStateChangeKeys((keys) => {
        const next = new Set(keys);
        next.delete(jobKey);
        return next;
      });
    }
  };

  const handleTrigger = async (job: CronJob) => {
    const jobKey = getJobKey(job);
    const label = `${t.cron.triggerNow}: "${truncateText(getJobTitle(job), 30)}"`;
    const viewProfile = selectedProfile;
    const controller = triggerControllerRef.current;

    if (!controller) return;

    try {
      // No pre-request toast: the controller's running state already gives
      // immediate in-progress feedback (disabled + spinning action), and a
      // success-styled toast before the HTTP response would claim a result
      // the request has not produced yet. Terminal feedback only.
      const result = await controller.run(
        jobKey,
        () => api.triggerCronJob(job.id, getJobProfile(job)),
      );

      if (
        triggerControllerRef.current !== controller ||
        selectedProfileRef.current !== viewProfile ||
        !result.started
      ) return;

      showToast(`${label} ✓`, "success");
      loadJobs(viewProfile);
    } catch (e) {
      if (
        triggerControllerRef.current === controller &&
        selectedProfileRef.current === viewProfile
      ) {
        showToast(cronErrorText(e), "error");
      }
    }
  };

  const jobDelete = useConfirmDelete({
    onDelete: useCallback(
      async (key: string) => {
        const { profile, id } = splitJobKey(key);
        const job = jobs.find((j) => getJobKey(j) === key);
        try {
          await api.deleteCronJob(id, profile);
          showToast(
            `${t.common.delete}: "${job ? truncateText(getJobTitle(job), 30) : id}"`,
            "success",
          );
          loadJobs(selectedProfile);
        } catch (e) {
          showToast(cronErrorText(e), "error");
          throw e;
        }
      },
      [jobs, loadJobs, selectedProfile, showToast, t.common.delete],
    ),
  });

  const openCreateModal = useCallback(() => {
    setCreateProfile(selectedProfile === "all" ? "default" : selectedProfile);
    setCreateModalOpen(true);
  }, [selectedProfile]);

  // Put "Create" button in page header
  useLayoutEffect(() => {
    setEnd(
      <Button className="uppercase" size="sm" onClick={openCreateModal}>
        {t.common.create}
      </Button>,
    );
    return () => {
      setEnd(null);
    };
  }, [setEnd, t.common.create, openCreateModal]);

  const pendingJob = jobDelete.pendingId
    ? jobs.find((j) => getJobKey(j) === jobDelete.pendingId)
    : null;

  const counts = cronJobCounts(jobs);
  const visibleJobs = filterCronJobs(jobs, listView, search);
  const formResources: CronJobFormResources = {
    availableSkills,
    availableToolsets,
    modelOptions,
    deliveryTargets,
  };

  return (
    <div className="flex flex-col gap-5">
      <PluginSlot name="cron:top" />
      <Toast toast={toast} />

      <Segmented
        value={view}
        onChange={(v) => setView(v as "jobs" | "blueprints")}
        options={[
          { value: "jobs", label: "Jobs" },
          { value: "blueprints", label: "Blueprints" },
        ]}
      />

      {view === "blueprints" && (
        <AutomationBlueprints
          profile={selectedProfile === "all" ? "default" : selectedProfile}
          onCreated={() => loadJobs(selectedProfile)}
        />
      )}

      <DeleteConfirmDialog
        open={jobDelete.isOpen}
        onCancel={jobDelete.cancel}
        onConfirm={jobDelete.confirm}
        title={t.cron.confirmDeleteTitle}
        description={
          pendingJob
            ? `"${truncateText(getJobTitle(pendingJob), 40)}" — ${
                t.cron.confirmDeleteMessage
              }`
            : t.cron.confirmDeleteMessage
        }
        loading={jobDelete.isDeleting}
      />

      {/* Create job */}
      <Dialog
        open={createModalOpen}
        onOpenChange={(open: boolean) => !open && setCreateModalOpen(false)}
      >
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t.cron.newJob}</DialogTitle>
            <DialogDescription>
              {t.cron.newJobHint ?? "A prompt the agent runs on a schedule, on its own."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 p-5 pt-0">
            <div className="grid gap-2">
              <Label htmlFor="cron-profile">Profile</Label>
              <Select
                id="cron-profile"
                value={createProfile}
                onValueChange={(v) => setCreateProfile(v)}
              >
                {profiles.map((profile) => (
                  <SelectOption key={profile.name} value={profile.name}>
                    {profileLabel(profile.name)}
                  </SelectOption>
                ))}
              </Select>
            </div>

            <CronJobFormFields
              idPrefix="cron"
              autoFocus
              form={createForm}
              onChange={setCreateForm}
              resources={formResources}
            />

            <div className="flex justify-end gap-2">
              <Button
                ghost
                className="uppercase"
                size="sm"
                onClick={() => setCreateModalOpen(false)}
              >
                {t.common.cancel}
              </Button>
              <Button
                className="uppercase"
                size="sm"
                onClick={handleCreate}
                disabled={creating}
                prefix={creating ? <Spinner /> : undefined}
              >
                {creating ? t.common.creating : t.common.create}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit job */}
      <Dialog
        open={editJob !== null}
        onOpenChange={(open: boolean) => !open && setEditJob(null)}
      >
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t.cron.editJob ?? "Edit job"}</DialogTitle>
            <DialogDescription>
              {editJob
                ? `${profileLabel(getJobProfile(editJob))} · ${editJob.id}`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {editJob && (
            <div className="grid gap-4 p-5 pt-0">
              <CronJobFormFields
                idPrefix="edit-cron"
                autoFocus
                form={editForm}
                onChange={setEditForm}
                resources={formResources}
              />

              <div className="flex justify-end gap-2">
                <Button
                  ghost
                  className="uppercase"
                  size="sm"
                  onClick={() => setEditJob(null)}
                >
                  {t.common.cancel}
                </Button>
                <Button
                  className="uppercase"
                  size="sm"
                  onClick={handleEdit}
                  disabled={saving}
                  prefix={saving ? <Spinner /> : undefined}
                >
                  {saving ? t.common.loading : (t.cron.saveChanges ?? "Save changes")}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {view === "jobs" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <CountFilter
              label={t.cron.views?.all ?? "All jobs"}
              count={counts.all}
              tone="neutral"
              active={listView === "all"}
              onClick={() => setListView("all")}
            />
            <CountFilter
              label={t.cron.views?.failing ?? "Failing"}
              count={counts.failing}
              tone="destructive"
              active={listView === "failing"}
              onClick={() => setListView("failing")}
            />
            <CountFilter
              label={t.cron.views?.scheduled ?? "Scheduled"}
              count={counts.scheduled}
              tone="success"
              active={listView === "scheduled"}
              onClick={() => setListView("scheduled")}
            />
            <CountFilter
              label={t.cron.views?.paused ?? "Paused"}
              count={counts.paused}
              tone="warning"
              active={listView === "paused"}
              onClick={() => setListView("paused")}
            />
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="grid flex-1 gap-1">
              <Label htmlFor="cron-search">{t.cron.search ?? "Search"}</Label>
              <Input
                id="cron-search"
                type="search"
                placeholder={t.cron.searchPlaceholder ?? "Name, prompt, schedule or skill"}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="grid min-w-[200px] gap-1">
              <Label htmlFor="cron-profile-filter">Profile</Label>
              <Select
                id="cron-profile-filter"
                value={selectedProfile}
                onValueChange={(v) => setSelectedProfile(v)}
              >
                <SelectOption value="all">All profiles</SelectOption>
                {profiles.map((profile) => (
                  <SelectOption key={profile.name} value={profile.name}>
                    {profileLabel(profile.name)}
                  </SelectOption>
                ))}
              </Select>
            </div>
          </div>

          {loadError && (
            <Card>
              <CardContent className="flex flex-col items-start gap-2 py-4 text-sm">
                <span className="text-destructive">{loadError}</span>
                <Button
                  ghost
                  size="sm"
                  className="uppercase"
                  onClick={() => loadJobs(selectedProfile)}
                >
                  {t.common.retry}
                </Button>
              </CardContent>
            </Card>
          )}

          {loading && (
            <div className="flex items-center justify-center py-16">
              <Spinner className="text-2xl text-primary" />
            </div>
          )}

          {!loading && !loadError && jobs.length === 0 && (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-8 text-center text-sm text-muted-foreground">
                <span>{t.cron.noJobs}</span>
                <Button className="uppercase" size="sm" onClick={openCreateModal}>
                  {t.common.create}
                </Button>
              </CardContent>
            </Card>
          )}

          {!loading && jobs.length > 0 && visibleJobs.length === 0 && (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                {t.cron.noMatches ?? "No jobs match this filter."}
              </CardContent>
            </Card>
          )}

          {!loading &&
            visibleJobs.map((job) => {
              const state = cronJobState(job);
              const terminal = cronJobIsTerminal(job);
              const promptText = getJobPrompt(job);
              const title = getJobTitle(job);
              const hasName = Boolean(getJobName(job));
              const deliver = asText(job.deliver);
              const profile = getJobProfile(job);
              const jobKey = getJobKey(job);
              const mode = getJobMode(job);
              const modelDisplay = getModelDisplay(job);
              const toolsets = Array.isArray(job.enabled_toolsets)
                ? job.enabled_toolsets.filter(Boolean)
                : [];
              const skills = Array.isArray(job.skills)
                ? job.skills.filter(Boolean)
                : [];
              const lastResult = cronLastResult(job);
              const triggering = triggeringJobKeys.has(jobKey);
              const changingState = stateChangeKeys.has(jobKey);

              return (
                <Card key={jobKey} className={cn(terminal && "opacity-60")}>
                  <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:gap-4">
                    <div className="min-w-0 flex-1">
                      {/* Identity: what this job is, and whether it is armed. */}
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {title}
                        </span>
                        <Badge tone={STATUS_TONE[state] ?? "secondary"}>
                          {state}
                        </Badge>
                        {lastResult && lastResult.status !== "ok" && (
                          <Badge
                            tone={lastResult.tone}
                            title={lastResult.detail ?? undefined}
                            data-testid="cron-last-result"
                          >
                            {lastResult.status}
                          </Badge>
                        )}
                      </div>

                      {hasName && promptText && (
                        <p className="mb-1 truncate text-xs text-muted-foreground">
                          {truncateText(promptText, 120)}
                        </p>
                      )}

                      {/* Timing: the question the page exists to answer. */}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                        <span className="font-mono-ui">
                          {getJobScheduleDisplay(job, scheduleDescribeStrings)}
                        </span>
                        <span className="text-muted-foreground">
                          {t.cron.next}: {terminal ? "—" : formatTime(job.next_run_at)}
                        </span>
                        <span className="text-muted-foreground">
                          {t.cron.last}: {formatTime(job.last_run_at)}
                        </span>
                      </div>

                      {/* Everything else, one muted line — it used to be eight
                          badges competing with the job's own name. */}
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        <Meta>{profileLabel(profile)}</Meta>
                        <Meta>→ {deliver || "local"}</Meta>
                        <Meta>repeat: {getRepeatDisplay(job)}</Meta>
                        {mode !== "agent" && <Meta>{mode}</Meta>}
                        {modelDisplay && (
                          <Meta title={modelDisplay}>{modelDisplay}</Meta>
                        )}
                        {skills.length > 0 && (
                          <Meta title={skills.join(", ")}>
                            {skills.length === 1
                              ? skills[0]
                              : `${skills.length} skills`}
                          </Meta>
                        )}
                        {toolsets.length > 0 && (
                          <Meta title={toolsets.join(", ")}>
                            {toolsets.length} toolsets
                          </Meta>
                        )}
                      </div>

                      {job.last_delivery_error && (
                        <p className="mt-1.5 text-xs text-destructive">
                          delivery: {job.last_delivery_error}
                        </p>
                      )}
                      {job.last_fire_error?.detail && (
                        <p className="mt-1.5 text-xs text-destructive">
                          missed scheduled fire ({formatTime(job.last_fire_error.at ?? null)}):{" "}
                          {job.last_fire_error.detail}
                        </p>
                      )}
                      {job.last_error && (
                        <p className="mt-1.5 text-xs text-destructive">
                          {job.last_error}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        ghost
                        size="icon"
                        disabled={terminal || changingState}
                        title={
                          terminal
                            ? (t.cron.finishedNoResume ??
                              "This job has finished; there is nothing left to resume.")
                            : state === "paused"
                              ? t.cron.resume
                              : t.cron.pause
                        }
                        aria-label={
                          state === "paused" ? t.cron.resume : t.cron.pause
                        }
                        onClick={() => handlePauseResume(job)}
                        className={
                          state === "paused" ? "text-success" : "text-warning"
                        }
                      >
                        {changingState ? (
                          <Spinner />
                        ) : state === "paused" ? (
                          <Play />
                        ) : (
                          <Pause />
                        )}
                      </Button>

                      <Button
                        ghost
                        size="icon"
                        disabled={triggering || terminal}
                        title={
                          terminal
                            ? (t.cron.finishedNoRun ??
                            "This job has finished; there is nothing left to run.")
                            : t.cron.triggerNow
                        }
                        aria-label={t.cron.triggerNow}
                        onClick={() => handleTrigger(job)}
                      >
                        {triggering ? <Spinner /> : <Zap />}
                      </Button>

                      <Button
                        ghost
                        size="icon"
                        title={t.cron.editJob ?? "Edit job"}
                        aria-label={t.cron.editJob ?? "Edit job"}
                        onClick={() => openEditModal(job)}
                      >
                        <Pencil />
                      </Button>

                      <Button
                        ghost
                        destructive
                        size="icon"
                        title={t.common.delete}
                        aria-label={t.common.delete}
                        onClick={() => jobDelete.requestDelete(jobKey)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
        </div>
      )}

      <PluginSlot name="cron:bottom" />
    </div>
  );
}
