import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  api,
  ApiError,
  FIELD_NAMES,
  SKIPPED_DOC_TYPES,
  type BatchDetail,
  type FieldData,
  type FieldName,
  type FormData,
} from "@/lib/api";
import {
  displayValue,
  docTypeLabel,
  errorText,
  fieldLabel,
  formReasonLabel,
  hasRole,
  parseUtc,
  reasonLabel,
  rolesOf,
} from "@/lib/labels";
import { useI18n, type MessageKey, type Translate } from "@/i18n";
import { usePolling } from "@/hooks/usePolling";
import { ImageViewer, type FieldBox } from "@/components/ImageViewer";
import { cn } from "@/lib/utils";
import { useAuth } from "@/auth/AuthProvider";
import { FormWorkflowBar } from "@/components/workflow";
import { SuggestInput } from "@/components/ui/suggest-input";

type Filter = "all" | "ok" | "attention";

const stillWorking = (b: BatchDetail) =>
  b.status === "processing" || b.forms.some((f) => f.status === "processing" || f.status === "pending");

/** Not read: another document, or a blank page. Listed apart, with a way to say "it is a commitment". */
const isSkipped = (f: FormData) => SKIPPED_DOC_TYPES.includes(f.doc_type ?? "commitment");
/** A form to review: not skipped, and not a page merged behind another form. */
const isReadable = (f: FormData) => !f.parent_form_id && !isSkipped(f);

const GROUPS: { title: MessageKey; code: string; icon: string; fields: FieldName[] }[] = [
  {
    title: "group.patient",
    code: "SECTION_PATIENT_DEMO",
    icon: "badge",
    fields: ["full_name", "id_number"],
  },
  {
    title: "group.referral",
    code: "SECTION_REFERRAL",
    icon: "domain",
    fields: ["receipt_date", "sender"],
  },
  {
    title: "group.numbers",
    code: "SECTION_NUMBERS",
    icon: "pin",
    fields: ["central_numbers", "commitment_numbers"],
  },
  {
    title: "group.lab",
    code: "SECTION_TEST",
    icon: "biotech",
    fields: ["test_type", "referral_number"],
  },
];

const MONO_FIELDS: FieldName[] = ["id_number", "central_numbers", "receipt_date", "commitment_numbers", "referral_number"];

function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`}>{name}</span>;
}

const pct = (c: number) => `${(c * 100).toFixed(1)}%`;

function reasonText(t: Translate, field: FieldData, ruleNames?: Record<string, string>): string {
  return field.reasons.map((r) => reasonLabel(t, r.code, ruleNames, r.detail)).join(" · ");
}

/** Where a page stands while the batch is being read: queued, being read, ready, reviewed... */
type PageState = "queued" | "reading" | "ready" | "reviewed" | "failed";

function pageState(f: FormData, reviewCount: number): PageState {
  if (f.status === "pending") return "queued";
  if (f.status === "processing") return "reading";
  if (f.status === "failed") return "failed";
  return reviewCount > 0 ? "ready" : "reviewed";
}

const PAGE_STATE_STYLE: Record<PageState, { icon: string; cls: string }> = {
  queued: { icon: "schedule", cls: "bg-surface-container text-on-surface-variant" },
  reading: { icon: "progress_activity", cls: "bg-secondary/10 text-secondary" },
  ready: { icon: "edit_note", cls: "bg-tertiary/10 text-tertiary" },
  reviewed: { icon: "check", cls: "bg-primary-container/20 text-on-primary-container" },
  failed: { icon: "error", cls: "bg-error-container text-on-error-container" },
};

/** While the batch is being read: how many pages are ready, the time left, and every page with its state. */
function LivePages({
  forms,
  reviewCount,
  createdAt,
  selectedId,
  onSelect,
}: {
  forms: FormData[];
  reviewCount: (f: FormData) => number;
  createdAt: string;
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const ready = forms.filter((f) => f.status === "done" || f.status === "failed").length;
  const total = forms.length || 1;
  const elapsed = Math.max((now - parseUtc(createdAt).getTime()) / 1000, 0);
  const eta = ready > 0 && ready < total ? Math.round((elapsed / ready) * (total - ready)) : null;
  const refining = forms.some((f) => f.refining);
  return (
    <div className="bg-surface-container-lowest rounded-xl p-3 shadow-md flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <span className="flex items-center gap-2 font-label-md text-label-md text-on-surface">
          <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          {t("live.ready", { ready, total })}
          {eta !== null && (
            <span className="text-on-surface-variant">
              · {eta >= 90 ? t("proc.etaMinutes", { count: Math.ceil(eta / 60) }) : t("proc.etaSeconds", { count: eta })}
            </span>
          )}
        </span>
        {refining && (
          <span className="flex items-center gap-1 font-body-sm text-body-sm text-secondary">
            <Icon name="sync" className="text-[16px] animate-spin" /> {t("live.refiningNote")}
          </span>
        )}
      </div>
      <div className="h-1.5 w-full bg-surface-container rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-l from-[#2BB99B] to-[#2B296D] transition-all"
          style={{ width: `${Math.round((ready / total) * 100)}%` }}
        />
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {forms.map((f, i) => {
          const state = pageState(f, reviewCount(f));
          const style = PAGE_STATE_STYLE[state];
          const clickable = f.status === "done" || f.status === "failed";
          return (
            <button
              key={f.id}
              type="button"
              disabled={!clickable}
              onClick={() => onSelect(f.id)}
              title={t(`live.state.${state}`)}
              className={cn(
                "shrink-0 flex items-center gap-1 px-2 py-1 rounded-full font-label-sm text-label-sm font-bold transition-all",
                style.cls,
                f.id === selectedId && "ring-2 ring-primary",
                !clickable && "cursor-default opacity-80",
              )}
            >
              <span className="font-data-mono-sm text-data-mono-sm">{i + 1}</span>
              <Icon name={style.icon} className={cn("text-[14px]", state === "reading" && "animate-spin")} />
              {f.refining && <Icon name="sync" className="text-[12px] animate-spin" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface RowProps {
  name: FieldName;
  field: FieldData;
  ruleNames?: Record<string, string>;
  senders?: string[];
  onFocusField: (n: FieldName | null) => void;
  onHover: (n: FieldName | null) => void;
  onSave: (field: FieldData, value: string) => Promise<FieldData>;
  onApprove: (field: FieldData) => Promise<FieldData>;
  onNext: (n: FieldName) => void;
  /** Throw away the whole commitment (offered on a name that clashes with the patient file). */
  onDeleteForm?: () => void;
}

/** One editable field of the form card. Focusing or hovering it frames the same field on the scanned form. */
function FieldRow({ name, field, ruleNames, senders, onFocusField, onHover, onSave, onApprove, onNext, onDeleteForm }: RowProps) {
  const { t, dir } = useI18n();
  const text = displayValue(name, field.value);
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  const editing = useRef(false);
  const shownId = useRef(field.id);
  // A new server value replaces the draft, except while the user is typing in this field
  // (the batch is polled while other forms are still being read).
  useEffect(() => {
    if (shownId.current !== field.id || !editing.current) setDraft(text);
    shownId.current = field.id;
  }, [text, field.id]);

  const review = field.level === "review";
  const nameChange = review && field.reasons.some((r) => r.code === "name_change");
  const mono = MONO_FIELDS.includes(name);
  const ltr = mono;

  async function commit(approve: boolean, value = draft) {
    if (busy) return;
    setBusy(true);
    try {
      if (value.trim() !== text) await onSave(field, value.trim());
      else if (approve && review) await onApprove(field);
    } finally {
      setBusy(false);
    }
  }

  const inputProps = {
    id: `field-input-${name}`,
    value: draft,
    dir: ltr ? "ltr" : "auto",
    placeholder: name === "receipt_date" ? "DD/MM/YYYY" : "",
    onFocus: (e: FocusEvent<HTMLInputElement>) => {
      editing.current = true;
      onFocusField(name);
      e.currentTarget.select();
    },
    onBlur: () => {
      editing.current = false;
      onFocusField(null);
      commit(false);
    },
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit(true).then(() => onNext(name));
      } else if (e.key === "Escape") {
        editing.current = false;
        setDraft(text);
        e.currentTarget.blur();
      }
    },
    className: cn(
      "w-full rounded-lg px-3 py-2 focus:outline-none shadow-sm transition-all",
      mono ? cn("text-data-mono-lg font-data-mono-lg", dir === "rtl" ? "text-right" : "text-left") : "text-body-md font-body-md",
      review
        ? "bg-surface-container-lowest font-bold text-tertiary ring-2 ring-tertiary"
        : "bg-surface-container-low text-on-surface focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary",
      mono && !review && "font-bold text-secondary",
    ),
  };
  const input =
    name === "sender" ? (
      <SuggestInput
        {...inputProps}
        options={senders ?? []}
        onChange={setDraft}
        onPick={(v) => {
          setDraft(v);
          commit(true, v);
        }}
      />
    ) : (
      <input {...inputProps} onChange={(e) => setDraft(e.target.value)} />
    );

  if (review) {
    return (
      <div
        className="rounded-xl p-4 bg-tertiary-container/15 shadow-sm space-y-2 transition-all"
        onMouseEnter={() => onHover(name)}
        onMouseLeave={() => onHover(null)}
      >
        <div className="flex items-center justify-between">
          <label
            className="font-label-md text-label-md font-bold text-tertiary flex items-center gap-1.5"
            htmlFor={`field-input-${name}`}
          >
            <Icon name="priority_high" className="text-tertiary text-[18px]" />
            {t("review.needsCheck", { label: fieldLabel(t, name) })}
          </label>
          <span className="font-data-mono-sm text-data-mono-sm bg-tertiary text-on-tertiary font-bold px-2 py-0.5 rounded-full flex items-center gap-1 shadow-xs">
            <Icon name="warning" className="text-[12px]" />
            {t("review.certainty", { pct: pct(field.confidence) })}
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
          <div className="sm:col-span-8">{input}</div>
          <div className="sm:col-span-4 flex gap-1">
            <button
              className="w-full bg-primary text-on-primary hover:bg-primary/90 font-label-md text-label-md font-bold px-3 py-2 rounded-lg flex items-center justify-center gap-1 shadow-sm transition-transform active:scale-95"
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(true)}
            >
              <Icon name="check" className="text-[16px]" />
              <span>{nameChange ? t("review.approveNameChange") : t("review.approve")}</span>
            </button>
          </div>
        </div>
        {field.reasons.length > 0 && (
          <div className="flex items-start gap-2 pt-1 text-on-tertiary-fixed-variant font-body-sm text-body-sm leading-tight">
            <Icon name="info" className="text-[16px] text-tertiary shrink-0 mt-0.5" />
            <span>
              <strong className="font-bold">{reasonText(t, field, ruleNames)}</strong>
              {field.value === null ? t("review.notFound") : t("review.checkOriginal")}
            </span>
          </div>
        )}
        {nameChange && onDeleteForm && (
          <button
            type="button"
            className="text-error font-label-md text-label-md font-bold flex items-center gap-1 pt-1"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onDeleteForm}
          >
            <Icon name="delete" className="text-[16px]" />
            {t("review.deleteForm")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1" onMouseEnter={() => onHover(name)} onMouseLeave={() => onHover(null)}>
      <div className="flex justify-between items-center">
        <label className="font-label-md text-label-md font-bold text-on-surface" htmlFor={`field-input-${name}`}>
          {fieldLabel(t, name)}
        </label>
        {field.manually_corrected ? (
          <span className="font-data-mono-sm text-data-mono-sm text-secondary flex items-center gap-0.5">
            <Icon name="edit" className="text-[14px]" /> {t("review.manual")}
          </span>
        ) : field.value === null ? (
          <span className="font-data-mono-sm text-data-mono-sm text-outline">
            {field.reasons.some((r) => r.code === "not_identified") ? t("reason.not_identified") : t("review.empty")}
          </span>
        ) : (
          <span className="font-data-mono-sm text-data-mono-sm text-primary flex items-center gap-0.5">
            <Icon name="verified" className="text-[14px]" /> {pct(field.confidence)}
          </span>
        )}
      </div>
      {input}
    </div>
  );
}

export function ReviewPage() {
  const batchId = Number(useParams().id);
  const navigate = useNavigate();
  const { t, dir } = useI18n();
  const { user } = useAuth();
  const roles = rolesOf(user);
  // the approver only reviews: read-only unless the user also holds an editing role
  const viewOnly = !hasRole(user, "intake", "lab_manager");
  const [params] = useSearchParams();
  const wantedForm = Number(params.get("form")) || null;
  const { data: batch, setData, error, refresh } = usePolling(
    () => api.getBatch(batchId),
    stillWorking,
    1000,
    [batchId],
    api.batchEventsUrl(batchId),
  );
  /** Enter on the last field while the next page is still being read: jump there when it is ready. */
  const [waitingNext, setWaitingNext] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seenDone = useRef<Set<number> | null>(null);
  const [senders, setSenders] = useState<string[]>([]);
  const [selectedForm, setSelectedForm] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [focused, setFocused] = useState<FieldName | null>(null);
  const [hovered, setHovered] = useState<FieldName | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    api.senders().then(setSenders).catch(() => {});
  }, []);

  const allForms = batch?.forms ?? [];
  const forms = allForms.filter(isReadable);
  const skippedForms = allForms.filter((f) => !f.parent_form_id && isSkipped(f));

  useEffect(() => {
    if (!allForms.length) return;
    const selectable = [...forms, ...skippedForms];
    if (wantedForm && selectedForm === null && allForms.some((f) => f.id === wantedForm)) {
      const wanted = allForms.find((f) => f.id === wantedForm)!;
      setSelectedForm(wanted.parent_form_id ?? wanted.id); // opened from a queue
      return;
    }
    if (selectedForm === null || !selectable.some((f) => f.id === selectedForm)) {
      const firstReview = forms.find((f) => FIELD_NAMES.some((n) => f.fields[n]?.level === "review"));
      const first = firstReview ?? forms[0] ?? selectable[0];
      if (first) setSelectedForm(first.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch, selectedForm, wantedForm]);

  const reviewCount = (f: FormData) => FIELD_NAMES.filter((n) => f.fields[n]?.level === "review").length;

  // A page that just became ready: a short note, without moving the user away from what they are doing.
  useEffect(() => {
    if (!batch) return;
    const done = forms.filter((f) => f.status === "done");
    if (seenDone.current === null) {
      seenDone.current = new Set(done.map((f) => f.id));
      return;
    }
    const fresh = done.filter((f) => !seenDone.current!.has(f.id));
    fresh.forEach((f) => seenDone.current!.add(f.id));
    if (!fresh.length) return;
    if (waitingNext !== null && selectedForm === waitingNext) {
      const next = fresh.find((f) => reviewCount(f) > 0) ?? fresh[0];
      setWaitingNext(null);
      setSelectedForm(next.id);
      const first = FIELD_NAMES.find((n) => next.fields[n]?.level === "review");
      if (first) window.setTimeout(() => focusInput(first), 80);
      return;
    }
    const page = forms.findIndex((f) => f.id === fresh[fresh.length - 1].id) + 1;
    setToast(t("live.newReady", { page }));
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch]);

  // The user moved on by themselves: stop waiting to jump.
  useEffect(() => {
    if (waitingNext !== null && selectedForm !== waitingNext) setWaitingNext(null);
  }, [selectedForm, waitingNext]);

  const files = useMemo(
    () =>
      (batch?.files ?? []).map((file) => {
        const fs = forms.filter((f) => f.source_file_id === file.id);
        return { file, forms: fs, review: fs.reduce((a, f) => a + reviewCount(f), 0) };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [batch],
  );

  if (error && !batch) return <div className="p-6 text-error">{error}</div>;
  if (!batch)
    return (
      <div className="flex items-center gap-2 p-6 text-outline">
        <Icon name="progress_activity" className="animate-spin" /> {t("common.loading")}
      </div>
    );

  const selected = allForms.find((f) => f.id === selectedForm);
  const selectedSkipped = !!selected && isSkipped(selected);
  const working = stillWorking(batch);
  const stillReading = allForms.filter((f) => f.status === "processing" || f.status === "pending").length;
  const currentFile = files.find((x) => x.file.id === selected?.source_file_id);
  const pageNo = Math.max(currentFile && selected ? currentFile.forms.findIndex((f) => f.id === selected.id) : 0, 0);
  const pages = currentFile?.forms ?? [];
  const pending = batch.counts.review;
  const totalFields = batch.counts.ok + batch.counts.review + batch.counts.empty;

  function replaceField(updated: FieldData, formId: number) {
    setData((prev) =>
      prev
        ? {
            ...prev,
            forms: prev.forms.map((f) =>
              f.id === formId ? { ...f, fields: { ...f.fields, [updated.name]: updated } } : f,
            ),
            counts: recount(prev, formId, updated),
          }
        : prev,
    );
    setSaveError(null);
    setSavedAt(Date.now());
  }

  /** Keep the header counters in step with an edit without waiting for a refetch. */
  function recount(b: BatchDetail, formId: number, updated: FieldData) {
    const old = b.forms.find((f) => f.id === formId)?.fields[updated.name];
    const counts = { ...b.counts };
    if (old) counts[old.level] -= 1;
    counts[updated.level] += 1;
    return counts;
  }

  async function guard(formId: number, fn: () => Promise<FieldData>): Promise<FieldData> {
    try {
      const updated = await fn();
      replaceField(updated, formId);
      return updated;
    } catch (e) {
      if (e instanceof ApiError && e.code === "conflict") {
        // someone saved this field after we loaded it: show their value instead of overwriting it
        const theirs = e.data?.field as FieldData | undefined;
        if (theirs) replaceField(theirs, formId);
        const by = e.data?.by as string | undefined;
        setSaveError(by ? t("review.conflict", { name: by }) : t("review.conflictAnon"));
        refresh();
      } else setSaveError(t("review.saveFailed", { error: (e as Error).message }));
      throw e;
    }
  }

  /** Run a form-level action, then reload; `select` picks the form to show afterwards. */
  async function formAction(fn: () => Promise<unknown>, select?: number) {
    try {
      await fn();
      if (select !== undefined) setSelectedForm(select);
      setSaveError(null);
      refresh();
    } catch (e) {
      setSaveError(errorText(t, (e as { code?: string | null }).code, (e as Error).message));
    }
  }

  async function retry(form: FormData) {
    const edited = FIELD_NAMES.some((n) => form.fields[n]?.manually_corrected);
    if (edited && !window.confirm(t("review.retryManualConfirm"))) return;
    await formAction(() => api.retryForm(form.id));
  }

  async function deleteForm(form: FormData) {
    if (!window.confirm(t("review.deleteFormConfirm"))) return;
    await formAction(() => api.deleteForm(form.id), forms.find((f) => f.id !== form.id)?.id);
  }

  async function splitPages(form: FormData) {
    if (!window.confirm(t("review.splitConfirm"))) return;
    await formAction(() => api.splitForm(form.id));
  }

  async function mergePrevious(form: FormData) {
    if (!window.confirm(t("review.mergePrevConfirm"))) return;
    try {
      const res = await api.mergePrevious(form.id);
      await formAction(async () => {}, res.parent_form_id);
    } catch (e) {
      setSaveError((e as Error).message);
    }
  }

  async function resetForm() {
    if (!selected) return;
    const touched = FIELD_NAMES.map((n) => selected.fields[n]).filter((f): f is FieldData => !!f && f.manually_corrected);
    if (!touched.length) return;
    if (!window.confirm(t("review.resetConfirm"))) return;
    for (const f of touched) await guard(selected.id, () => api.resetField(f.id)).catch(() => {});
  }

  const focusInput = (n: FieldName) => document.getElementById(`field-input-${n}`)?.focus();

  function goToNext(from: FieldName) {
    if (!selected) return;
    const i = FIELD_NAMES.indexOf(from);
    const order = [...FIELD_NAMES.slice(i + 1), ...FIELD_NAMES.slice(0, i)];
    const nextReview = order.find((n) => selected.fields[n]?.level === "review");
    if (nextReview) return focusInput(nextReview);
    const idx = forms.findIndex((f) => f.id === selected.id);
    const other = [...forms.slice(idx + 1), ...forms.slice(0, idx)].find((f) => reviewCount(f) > 0);
    if (other) {
      setSelectedForm(other.id);
      const first = FIELD_NAMES.find((n) => other.fields[n]?.level === "review");
      if (first) window.setTimeout(() => focusInput(first), 80);
    } else {
      (document.activeElement as HTMLElement | null)?.blur();
      // nothing left to fix yet, but pages are still being read: go to the next one when it is ready
      if (forms.some((f) => f.status === "processing" || f.status === "pending")) setWaitingNext(selected.id);
    }
  }

  function jumpToAlert() {
    if (!selected) return;
    const n = FIELD_NAMES.find((x) => selected.fields[x]?.level === "review");
    if (n) focusInput(n);
  }

  const hasApproved = forms.some((f) => f.workflow === "approved");

  async function proceed() {
    if (!hasRole(user, "lab_manager")) return navigate(hasApproved ? `/batches/${batch!.id}/export` : "/me");
    if (pending > 0 && !window.confirm(t("review.proceedConfirm", { count: pending }))) return;
    try {
      await api.finalizeBatch(batch!.id); // the manager needs no clerk or approver: submit + approve everything
    } catch (e) {
      return setSaveError((e as Error).message);
    }
    navigate(`/batches/${batch!.id}/export`);
  }

  const boxes: FieldBox[] =
    selected?.status === "done" && !selectedSkipped
      ? FIELD_NAMES.flatMap((n) => {
          const f = selected.fields[n];
          return f && f.box && f.value !== null
            ? [{ name: n, label: fieldLabel(t, n), box: f.box, level: f.level, confidence: f.confidence, verified: f.box_verified }]
            : [];
        })
      : [];

  // the approver reviews read-only; approved forms are frozen
  const readOnly = viewOnly || selected?.workflow === "approved";
  const ruleNames = batch.rule_names;
  const filedPatient =
    selected?.patient_id && (selected.patient_link === "auto" || selected.patient_link === "manual")
      ? selected.patient_id
      : null;

  const visible = (f: FieldData | null) =>
    !!f && (filter === "all" || (filter === "ok" ? f.level !== "review" : f.level === "review"));

  const pillBase = "px-3 py-1.5 rounded-lg font-label-sm text-label-sm transition-all";
  const pillOn = "bg-surface-container-lowest text-on-surface font-bold shadow-sm";
  const pillOff = "text-on-surface-variant hover:text-on-surface";

  return (
    <>
      {/* Workspace Sub-Header & Controls Filter Bar */}
      <section className="w-full bg-surface-container-low/70 backdrop-blur-md px-margin py-space-md shadow-sm">
        <div className="max-w-[1440px] mx-auto flex flex-col xl:flex-row items-start xl:items-center justify-between gap-space-md">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-space-sm">
              <div className="w-2.5 h-7 bg-primary rounded-full"></div>
              <h1 className="font-headline-lg text-headline-lg text-on-surface tracking-tight font-bold">
                {t("review.title")}
              </h1>
              <span className="bg-primary-container/20 text-on-primary-container px-2.5 py-0.5 rounded-full font-label-sm text-label-sm font-bold flex items-center gap-1">
                <Icon name="auto_fix_high" className="text-[14px]" />
                {t("review.badge")}
              </span>
            </div>
            <p className="font-body-md text-body-md text-on-surface-variant ps-4">
              {t("review.subtitle")}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-space-sm w-full xl:w-auto">
            <div className="flex items-center bg-surface-container rounded-xl p-1 gap-1 overflow-x-auto max-w-full">
              {files.map(({ file, forms: fs, review }) => {
                const on = file.id === selected?.source_file_id;
                return (
                  <button
                    key={file.id}
                    type="button"
                    onClick={() => {
                      const first = fs.find((f) => reviewCount(f) > 0) ?? fs[0];
                      if (first) setSelectedForm(first.id);
                    }}
                    className={cn(
                      "flex items-center gap-2 px-3.5 py-2 rounded-lg font-label-md text-label-md transition-all shrink-0",
                      on
                        ? "bg-surface-container-lowest text-on-surface shadow-sm font-bold"
                        : "text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest/60",
                    )}
                  >
                    <Icon
                      name={review > 0 ? "warning" : "check_circle"}
                      className={cn("text-[18px]", review > 0 ? "text-tertiary" : "text-primary")}
                    />
                    <span className="truncate max-w-[160px]" dir="auto" title={file.filename}>
                      {file.filename}
                    </span>
                    {review > 0 && (
                      <span className="bg-tertiary text-on-tertiary px-1.5 py-0.2 rounded-full font-data-mono-sm text-data-mono-sm">
                        {review}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1 bg-surface-container-highest/70 p-1 rounded-xl">
              <button className={cn(pillBase, filter === "all" ? pillOn : pillOff)} onClick={() => setFilter("all")}>
                {t("review.filterAll", { count: totalFields })}
              </button>
              <button className={cn(pillBase, filter === "ok" ? pillOn : pillOff)} onClick={() => setFilter("ok")}>
                {t("review.filterOk", { count: batch.counts.ok })}
              </button>
              <button
                className={cn(
                  pillBase,
                  "flex items-center gap-1.5",
                  filter === "attention" ? pillOn : "bg-tertiary/10 text-tertiary font-bold",
                )}
                onClick={() => setFilter("attention")}
              >
                <span className={cn("w-2 h-2 rounded-full bg-tertiary", pending > 0 && "animate-pulse")}></span>
                {t("review.filterAttention", { count: pending })}
              </button>
            </div>
          </div>
        </div>
      </section>

      {saveError && (
        <div className="w-full px-margin pt-space-sm">
          <div className="max-w-[1440px] mx-auto rounded-lg bg-error-container px-4 py-1.5 text-body-md text-on-error-container">
            {saveError}
          </div>
        </div>
      )}

      {/* Dual-Pane Verification Workspace */}
      <section className="w-full px-margin py-space-lg flex-1">
        <div className="max-w-[1440px] mx-auto grid grid-cols-1 lg:grid-cols-12 gap-space-lg items-start">
          {selected && selected.status === "done" ? (
            <ImageViewer
              src={api.imageUrl(selected.id, selected.image_rev)}
              pages={(selected.page_ids ?? [selected.id]).map((id) =>
                api.imageUrl(id, allForms.find((x) => x.id === id)?.image_rev))}
              title={t("review.sourceTitle", { file: selected.filename })}
              subtitle={t("review.sourceSubtitle", {
                page: pageNo + 1,
                total: pages.length || 1,
                marked: t("proc.marked", { count: boxes.length }),
              })}
              boxes={boxes}
              highlight={focused ?? hovered}
              focused={focused}
              onJumpToAlert={reviewCount(selected) > 0 ? jumpToAlert : null}
              footer={`FORM #${selected.id} // ${boxes.length}/${FIELD_NAMES.length} FIELDS MAPPED`}
            />
          ) : (
            <div className="lg:col-span-6 bg-surface-container-lowest rounded-[20px] shadow-lg p-space-lg text-body-md text-outline min-h-[200px] flex items-center justify-center">
              {working ? t("review.waitingForm") : t("review.pickForm")}
            </div>
          )}

          {/* Extracted editable fields form */}
          <div className="lg:col-span-6 flex flex-col gap-space-sm order-2 lg:order-2">
            <div className="bg-surface-container-lowest rounded-xl p-3 shadow-md flex items-center justify-between gap-space-sm">
              <div className="flex items-center gap-space-sm min-w-0">
                <div className="w-8 h-8 rounded-lg bg-secondary/10 text-secondary flex items-center justify-center shrink-0">
                  <Icon name="table_view" className="text-[20px]" />
                </div>
                <div className="min-w-0">
                  <span className="font-headline-sm text-headline-sm text-on-surface block leading-tight font-bold">
                    {t("review.mapTitle")}
                  </span>
                  <span className="font-label-md text-label-md text-on-surface-variant">
                    {t("review.mapHint")}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {filedPatient && (
                  <Link
                    to={`/patients/${filedPatient}`}
                    className="text-secondary hover:bg-secondary/5 px-2.5 py-1.5 rounded-lg font-label-md text-label-md font-bold flex items-center gap-1"
                  >
                    <Icon name="folder_shared" className="text-[16px]" />
                    {t("patients.openFile")}
                  </Link>
                )}
                {pages.length > 1 && (
                  <div className="flex items-center gap-1 bg-surface-container-low p-1 rounded-lg">
                    <button
                      type="button"
                      title={t("review.prevPage")}
                      disabled={pageNo <= 0}
                      onClick={() => setSelectedForm(pages[pageNo - 1].id)}
                      className="w-8 h-8 rounded flex items-center justify-center hover:bg-surface-container disabled:opacity-30"
                    >
                      <Icon name={dir === "rtl" ? "chevron_right" : "chevron_left"} className="text-[20px]" />
                    </button>
                    <span className="font-data-mono-sm text-data-mono-sm px-1">
                      {pageNo + 1}/{pages.length}
                    </span>
                    <button
                      type="button"
                      title={t("review.nextPage")}
                      disabled={pageNo >= pages.length - 1}
                      onClick={() => setSelectedForm(pages[pageNo + 1].id)}
                      className="w-8 h-8 rounded flex items-center justify-center hover:bg-surface-container disabled:opacity-30"
                    >
                      <Icon name={dir === "rtl" ? "chevron_left" : "chevron_right"} className="text-[20px]" />
                    </button>
                  </div>
                )}
                <button
                  className="text-primary hover:bg-primary/5 px-2.5 py-1.5 rounded-lg font-label-md text-label-md font-bold flex items-center gap-1 transition-colors disabled:opacity-40"
                  type="button"
                  onClick={resetForm}
                  disabled={readOnly}
                >
                  <Icon name="refresh" className="text-[16px]" />
                  {t("review.reset")}
                </button>
              </div>
            </div>

            {working && forms.length > 0 && (
              <LivePages
                forms={forms}
                reviewCount={reviewCount}
                createdAt={batch.created_at}
                selectedId={selected?.id ?? null}
                onSelect={setSelectedForm}
              />
            )}

            {waitingNext !== null && (
              <div className="flex items-center gap-2 rounded-xl bg-secondary/10 text-secondary px-3 py-2 font-body-sm text-body-sm">
                <Icon name="hourglass_top" className="text-[16px] animate-pulse" />
                {t("live.waitingNext")}
              </div>
            )}

            {working && stillReading > 0 && forms.length === 0 && (
              <div className="flex items-center gap-2 rounded-xl bg-primary-container/15 text-on-primary-container px-3 py-2 font-body-sm text-body-sm">
                <Icon name="progress_activity" className="animate-spin text-[16px] text-primary" />
                {t("review.stillReading", { count: stillReading })}
              </div>
            )}

            {selected?.refining && (
              <div className="flex items-center gap-2 rounded-xl bg-secondary/5 text-secondary px-3 py-2 font-body-sm text-body-sm">
                <Icon name="sync" className="animate-spin text-[16px]" />
                {t("live.refining")}
              </div>
            )}

            {selected && selected.status === "done" && !selectedSkipped && (
              <FormNotes
                form={selected}
                canEdit={!readOnly}
                canMergePrev={pageNo > 0}
                onSplit={() => splitPages(selected)}
                onMergePrev={() => mergePrevious(selected)}
                onNotCommitment={() => formAction(() => api.setDocType(selected.id, "unrelated"))}
              />
            )}

            {selected && !selectedSkipped && (
              <FormWorkflowBar
                form={selected}
                roles={roles}
                flagged={FIELD_NAMES.filter((n) => selected.fields[n] && selected.fields[n]!.level !== "ok").length}
                onDone={refresh}
                onError={setSaveError}
              />
            )}

            <fieldset
              disabled={readOnly}
              className="bg-surface-container-lowest rounded-[20px] shadow-lg p-space-lg space-y-space-lg min-w-0 border-0 m-0"
            >
              {selected && selectedSkipped ? (
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <Icon name="block" className="text-outline text-[40px]" />
                  <p className="text-body-md text-on-surface-variant">
                    {t("review.notCommitmentSelected", { type: docTypeLabel(t, selected.doc_type ?? "unrelated") })}
                  </p>
                  <button
                    type="button"
                    onClick={() => formAction(() => api.setDocType(selected.id, "commitment"))}
                    className="bg-primary text-on-primary font-label-md text-label-md font-bold px-4 py-2 rounded-lg flex items-center gap-1"
                  >
                    <Icon name="description" className="text-[16px]" /> {t("review.isCommitment")}
                  </button>
                </div>
              ) : selected?.status === "failed" ? (
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <Icon name="error" className="text-error text-[40px]" />
                  <p className="text-body-md text-on-surface-variant">
                    {selected.error_code || selected.error
                      ? errorText(t, selected.error_code, selected.error)
                      : t("review.formFailed")}
                  </p>
                  <button
                    type="button"
                    onClick={() => retry(selected)}
                    className="bg-primary text-on-primary font-label-md text-label-md font-bold px-4 py-2 rounded-lg flex items-center gap-1"
                  >
                    <Icon name="refresh" className="text-[16px]" /> {t("common.retry")}
                  </button>
                </div>
              ) : !selected || selected.status !== "done" ? (
                <div className="flex items-center justify-center gap-2 py-8 text-outline">
                  <Icon name="progress_activity" className="animate-spin" /> {t("common.processing")}
                </div>
              ) : (
                <>
                  {GROUPS.map((g, gi) => {
                    const rows = g.fields.filter((n) => visible(selected.fields[n]));
                    if (!rows.length) return null;
                    return (
                      <fieldset key={g.code} className={cn("space-y-space-md", gi > 0 && "pt-2")}>
                        <div className="flex items-center justify-between border-b border-surface-container pb-2">
                          <div className="flex items-center gap-2">
                            <Icon name={g.icon} className="text-primary text-[20px]" />
                            <legend className="font-headline-sm text-headline-sm font-bold text-secondary">
                              {t(g.title)}
                            </legend>
                          </div>
                          <span className="text-label-sm font-data-mono-sm bg-surface-container text-on-surface-variant px-2 py-0.5 rounded-full">
                            {g.code}
                          </span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
                          {rows.map((n) => {
                            const f = selected.fields[n]!;
                            return (
                              <div key={n} className={cn(f.level === "review" && "md:col-span-2")}>
                                <FieldRow
                                  name={n}
                                  field={f}
                                  ruleNames={ruleNames}
                                  senders={senders}
                                  onFocusField={setFocused}
                                  onHover={setHovered}
                                  onSave={(fd, v) =>
                                    guard(selected.id, () => api.updateField(fd.id, v === "" ? null : v, fd.version))
                                  }
                                  onApprove={(fd) => guard(selected.id, () => api.approveField(fd.id))}
                                  onNext={goToNext}
                                  onDeleteForm={() => deleteForm(selected)}
                                />
                              </div>
                            );
                          })}
                        </div>
                      </fieldset>
                    );
                  })}
                  {GROUPS.every((g) => g.fields.every((n) => !visible(selected.fields[n]))) && (
                    <div className="py-8 text-center text-body-md text-outline">
                      {filter === "attention" ? t("review.noneAttention") : t("review.noneVisible")}
                    </div>
                  )}
                </>
              )}
            </fieldset>

            {skippedForms.length > 0 && (
              <SkippedList
                forms={skippedForms}
                pagesIn={(fileId) => allForms.filter((x) => x.source_file_id === fileId && (x.region_index ?? 0) === 0).length}
                selectedId={selected?.id ?? null}
                onSelect={setSelectedForm}
                onRead={(f) => formAction(() => api.setDocType(f.id, "commitment"))}
                canEdit={!viewOnly}
              />
            )}
          </div>
        </div>
      </section>

      {/* Sticky Bottom Verification Action Bar */}
      <section className="sticky bottom-0 z-40 w-full bg-surface-container-lowest/95 backdrop-blur-md px-margin py-3 shadow-[0_-8px_20px_rgba(43,41,109,0.06)] border-t border-surface-container">
        <div className="max-w-[1440px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-space-sm">
          <div className="flex items-center gap-space-md">
            <Link
              to={`/batches/${batch.id}/processing`}
              className="text-on-surface-variant hover:text-on-surface font-label-md text-label-md flex items-center gap-1.5 transition-colors"
            >
              <Icon name={dir === "rtl" ? "arrow_forward" : "arrow_back"} className="text-[18px]" />
              <span>{t("review.back")}</span>
            </Link>
            <span className="h-4 w-[1px] bg-outline-variant/50 hidden sm:block"></span>
            {pending > 0 ? (
              <div className="flex items-center gap-2 bg-tertiary-container/30 px-3 py-1 rounded-full text-on-tertiary-container font-label-sm text-label-sm font-bold">
                <span className="w-2 h-2 rounded-full bg-tertiary animate-ping"></span>
                <span>{t("review.remaining", { count: pending })}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 bg-primary-container/20 px-3 py-1 rounded-full text-on-primary-container font-label-sm text-label-sm font-bold">
                <Icon name={working ? "progress_activity" : "task_alt"} className={cn("text-[16px] text-primary", working && "animate-spin")} />
                <span>{working ? t("review.waitingDone") : t("review.allVerified", { count: totalFields })}</span>
              </div>
            )}
            {batch.failed_forms > 0 && (
              <span className="font-label-sm text-label-sm text-error font-bold">{t("unit.formsFailed", { count: batch.failed_forms })}</span>
            )}
            {batch.failed_forms > 0 && !viewOnly && (
              <button
                type="button"
                onClick={() => formAction(() => api.retryFailed(batch.id))}
                className="font-label-sm text-label-sm text-primary font-bold underline flex items-center gap-1"
              >
                <Icon name="refresh" className="text-[14px]" />
                {t("review.retryAllFailed")}
              </button>
            )}
          </div>

          <div className="flex items-center gap-space-sm w-full sm:w-auto justify-end">
            <button
              className="px-4 py-2.5 rounded-[10px] text-secondary hover:bg-secondary/5 font-label-md text-label-md font-bold transition-all flex items-center gap-1"
              type="button"
              onClick={() => setSavedAt(Date.now())}
              title={t("review.autosave")}
            >
              <Icon name={savedAt ? "cloud_done" : "save"} className="text-[18px]" />
              <span>{savedAt ? t("review.saved") : t("review.saveDraft")}</span>
            </button>
            {hasApproved && !hasRole(user, "lab_manager") && (
              <button
                type="button"
                onClick={() => navigate(`/batches/${batch.id}/export`)}
                className="px-4 py-2.5 rounded-[10px] bg-surface-container text-secondary font-label-md text-label-md font-bold flex items-center gap-1"
              >
                <Icon name="download" className="text-[18px]" />
                <span>{t("export.download")}</span>
              </button>
            )}
            <button
              type="button"
              onClick={proceed}
              className="px-6 py-2.5 rounded-[10px] bg-primary-container text-on-primary hover:bg-[#249F85] font-headline-sm text-headline-sm font-bold shadow-md hover:shadow-lg transition-all flex items-center gap-2"
            >
              <span>{t("review.proceed")}</span>
              <Icon name={dir === "rtl" ? "arrow_back" : "arrow_forward"} className="text-[20px]" />
            </button>
          </div>
        </div>
      </section>

      {toast && (
        <div
          role="status"
          className="fixed bottom-24 start-1/2 -translate-x-1/2 rtl:translate-x-1/2 z-50 bg-secondary text-on-secondary px-4 py-2 rounded-full shadow-lg font-label-md text-label-md flex items-center gap-2"
        >
          <Icon name="fiber_new" className="text-[18px]" /> {toast}
        </div>
      )}

    </>
  );
}

/** Form-level doubts (several commitments on the page, poor photo, merged pages...) and page actions. */
function FormNotes({
  form,
  canEdit,
  canMergePrev,
  onSplit,
  onMergePrev,
  onNotCommitment,
}: {
  form: FormData;
  canEdit: boolean;
  canMergePrev: boolean;
  onSplit: () => void;
  onMergePrev: () => void;
  onNotCommitment: () => void;
}) {
  const { t } = useI18n();
  const reasons = form.reasons ?? [];
  const pages = form.page_ids?.length ?? 1;
  const merged = pages > 1;
  const btn =
    "px-2.5 py-1 rounded-lg font-label-sm text-label-sm font-bold flex items-center gap-1 transition-colors hover:bg-surface-container";
  return (
    <div className="bg-surface-container-lowest rounded-xl p-3 shadow-sm flex flex-col gap-2">
      {reasons.length > 0 && (
        <div className="flex items-start gap-2 text-on-tertiary-fixed-variant font-body-sm text-body-sm">
          <Icon name="flag" className="text-[18px] text-tertiary shrink-0" />
          <div className="flex flex-col gap-0.5">
            <strong className="font-bold text-tertiary">{t("review.formReasonsTitle")}</strong>
            {reasons.map((r) => (
              <span key={r}>{r === "merged_pages" ? t("review.mergedPages", { count: pages }) : formReasonLabel(t, r)}</span>
            ))}
          </div>
        </div>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-1 text-secondary">
          {merged && (
            <button type="button" className={btn} onClick={onSplit}>
              <Icon name="call_split" className="text-[16px]" /> {t("review.split")}
            </button>
          )}
          {canMergePrev && (
            <button type="button" className={btn} onClick={onMergePrev}>
              <Icon name="merge" className="text-[16px]" /> {t("review.mergePrev")}
            </button>
          )}
          <button type="button" className={cn(btn, "text-on-surface-variant")} onClick={onNotCommitment}>
            <Icon name="block" className="text-[16px]" /> {t("review.markNotCommitment")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Pages that were not read (another document, blank): kept with their image, never exported. */
function SkippedList({
  forms,
  pagesIn,
  selectedId,
  onSelect,
  onRead,
  canEdit,
}: {
  forms: FormData[];
  /** Pages in that source file, for "page 2 of 3". */
  pagesIn: (sourceFileId: number) => number;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onRead: (f: FormData) => void;
  canEdit: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="bg-surface-container-lowest rounded-[20px] shadow-md p-space-md flex flex-col gap-space-sm">
      <div className="flex items-center gap-2">
        <Icon name="block" className="text-outline text-[20px]" />
        <span className="font-headline-sm text-headline-sm font-bold text-secondary">
          {t("review.notCommitmentTitle")} ({forms.length})
        </span>
      </div>
      <p className="font-body-sm text-body-sm text-on-surface-variant">{t("review.notCommitmentHint")}</p>
      <div className="flex flex-col gap-2">
        {forms.map((f) => (
          <div
            key={f.id}
            className={cn(
              "flex items-center gap-3 rounded-xl p-2 transition-colors",
              f.id === selectedId ? "bg-surface-container" : "hover:bg-surface-container-low",
            )}
          >
            <button type="button" className="flex items-center gap-3 min-w-0 flex-1 text-start" onClick={() => onSelect(f.id)}>
              <img
                src={api.imageUrl(f.id, f.image_rev)}
                alt=""
                className="w-12 h-16 object-cover rounded-md bg-surface-container shrink-0"
                loading="lazy"
              />
              <span className="flex flex-col min-w-0">
                <span className="font-label-md text-label-md font-bold text-on-surface truncate" dir="auto">
                  {f.filename}
                </span>
                <span className="font-body-sm text-body-sm text-on-surface-variant">
                  {t("review.pageOf", { page: f.page_index + 1, total: Math.max(pagesIn(f.source_file_id), f.page_index + 1) })} · {docTypeLabel(t, f.doc_type ?? "unrelated")}
                </span>
              </span>
            </button>
            {canEdit && (
              <button
                type="button"
                onClick={() => onRead(f)}
                className="shrink-0 px-2.5 py-1 rounded-lg font-label-sm text-label-sm font-bold text-primary hover:bg-primary/5"
              >
                {t("review.isCommitment")}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
