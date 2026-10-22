import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, FIELD_NAMES, SKIPPED_DOC_TYPES, type BatchDetail, type FormData, type SourceFileData } from "@/lib/api";
import { errorText, fieldLabel, parseUtc, warningLabel } from "@/lib/labels";
import { useI18n, type MessageKey } from "@/i18n";
import { usePolling } from "@/hooks/usePolling";

const processing = (b: BatchDetail) => b.status === "processing";

/** A page still being read after this long gets a "slower than usual" note. */
const SLOW_FORM_SECONDS = 90;

const isReadable = (f: FormData) => !f.parent_form_id && !SKIPPED_DOC_TYPES.includes(f.doc_type ?? "commitment");

/** Batches already sent on to review at their first ready page (this session). */
const jumped = new Set<number>();

/** "Stay on the processing screen" (instead of jumping to review at the first ready page), remembered per browser. */
const STAY_KEY = "processing.stay";
function readStay(): boolean {
  try {
    return window.localStorage.getItem(STAY_KEY) === "1";
  } catch {
    return false;
  }
}
function writeStay(v: boolean) {
  try {
    window.localStorage.setItem(STAY_KEY, v ? "1" : "0");
  } catch {
    /* storage blocked */
  }
}

function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`}>{name}</span>;
}

/** A log event, kept as a message key so it re-renders when the language changes. */
interface LogEvent {
  key: MessageKey;
  params?: Record<string, string | number>;
}

interface LogLine extends LogEvent {
  at: number;
}

/** Log lines for what changed between two polls of the same batch. */
function diffLog(prev: BatchDetail, next: BatchDetail): LogEvent[] {
  const out: LogEvent[] = [];
  if (!prev.paused && next.paused) out.push({ key: "log.paused" });
  if (prev.paused && !next.paused) out.push({ key: "log.resumed" });
  for (const f of next.files) {
    const p = prev.files.find((x) => x.id === f.id);
    if (!p) continue;
    const file = f.filename;
    if (p.status !== "processing" && f.status === "processing") out.push({ key: "log.start", params: { file } });
    if (f.pages_total > p.pages_total) out.push({ key: "log.pages", params: { file, count: f.pages_total } });
    if (f.pages_done > p.pages_done)
      out.push({ key: "log.pageDone", params: { file, done: f.pages_done, total: f.pages_total } });
    if (f.fields_extracted > p.fields_extracted)
      out.push({ key: "log.fields", params: { file, done: f.fields_extracted, total: f.fields_total } });
    if (p.status !== "done" && f.status === "done") out.push({ key: "log.fileDone", params: { file } });
    if (p.status !== "failed" && f.status === "failed")
      out.push({ key: "log.fileFailed", params: { file, error: f.error_code ?? f.error ?? "" } });
  }
  return out;
}

/** Form shown in the live viewer: the one being read now, else the latest finished one. */
function pickForm(batch: BatchDetail): FormData | null {
  const reading = batch.forms.find((f) => f.status === "processing");
  if (reading) return reading;
  const done = batch.forms.filter((f) => f.status === "done");
  return done[done.length - 1] ?? batch.forms[0] ?? null;
}

export function ProcessingPage() {
  const batchId = Number(useParams().id);
  const navigate = useNavigate();
  const { t, locale } = useI18n();
  const { data: batch, error, refresh } = usePolling(
    () => api.getBatch(batchId),
    processing,
    1000,
    [batchId],
    api.batchEventsUrl(batchId),
  );
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const prev = useRef<BatchDetail | null>(null);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!batch) return;
    if (prev.current) {
      const lines = diffLog(prev.current, batch);
      if (lines.length) setLog((l) => [...l, ...lines.map((e) => ({ ...e, at: Date.now() }))].slice(-40));
    }
    prev.current = batch;
  }, [batch]);

  // Processing finished: a short pause so the last marked fields are visible, then on to review.
  useEffect(() => {
    if (!batch || processing(batch)) return;
    const t = window.setTimeout(() => navigate(`/batches/${batchId}`, { replace: true }), 1500);
    return () => window.clearTimeout(t);
  }, [batch, batchId, navigate]);

  // The first page is ready: start reviewing it while the others are still being read (unless asked to stay).
  const [stay, setStay] = useState(() => readStay());
  useEffect(() => {
    if (!batch || stay || !processing(batch) || jumped.has(batchId)) return;
    const first = batch.forms.find((f) => f.status === "done" && isReadable(f));
    if (first) {
      jumped.add(batchId); // once: coming back here to watch progress does not bounce to review again
      navigate(`/batches/${batchId}?form=${first.id}`);
    }
  }, [batch, batchId, navigate, stay]);

  const form = useMemo(() => (batch ? pickForm(batch) : null), [batch]);

  if (error && !batch) return <div className="p-8 text-error">{error}</div>;
  if (!batch)
    return (
      <div className="flex items-center gap-2 p-8 text-outline">
        <Icon name="progress_activity" className="animate-spin text-[18px]" /> {t("common.loading")}
      </div>
    );

  // with per-file upload, files still on their way count too
  const expected = Math.max(batch.files.length, batch.expected_files ?? 0);
  const uploadsPending = expected - batch.files.length;
  const total = expected || 1;
  const overall =
    batch.files.reduce((n, f) => n + (f.status === "done" || f.status === "failed" ? 1 : f.progress), 0) / total;
  const pct = Math.round(overall * 100);
  const doneFiles = batch.files.filter((f) => f.status === "done" || f.status === "failed").length;
  const fieldsTotal = batch.files.reduce((n, f) => n + f.fields_total, 0);
  const fieldsDone = batch.files.reduce((n, f) => n + f.fields_extracted, 0);
  const finished = !processing(batch);

  const started = new Date(batch.created_at + "Z").getTime();
  const elapsed = Math.max((now - started) / 1000, 0);
  const eta = overall > 0.05 && overall < 1 ? Math.round((elapsed * (1 - overall)) / overall) : null;
  const etaText = finished
    ? t("proc.done")
    : batch.paused
      ? t("proc.paused")
      : eta === null
        ? t("proc.etaCalc")
        : eta <= 1
          ? t("proc.etaLast")
          : eta >= 90
            ? t("proc.etaMinutes", { count: Math.ceil(eta / 60) })
            : t("proc.etaSeconds", { count: eta });

  const viewFile = form ? batch.files.find((f) => f.id === form.source_file_id) : undefined;
  const marked = form ? FIELD_NAMES.filter((n) => form.fields[n]?.box && form.fields[n]?.value !== null) : [];
  const reading = form?.status === "processing" && !batch.paused;
  const slowForm =
    reading && form?.started_at ? (now - parseUtc(form.started_at).getTime()) / 1000 > SLOW_FORM_SECONDS : false;
  const readyForReview = batch.forms.filter((f) => f.status === "done" && isReadable(f)).length;
  const skipped = batch.skipped_forms ?? 0;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!window.confirm(t("proc.cancelConfirm"))) return;
    await act(() => api.cancelBatch(batchId));
  }

  return (
    <div className="flex flex-col w-full pb-16">
      {/* Top dynamic context banner */}
      <div className="w-full px-margin pt-space-lg mb-space-lg">
        <div className="max-w-[1440px] mx-auto bg-surface-container-lowest rounded-[20px] shadow-[0_10px_30px_-5px_rgba(43,41,109,0.06)] p-space-lg md:p-space-xl relative overflow-hidden">
          <div className="absolute -top-24 -left-24 w-80 h-80 bg-primary-container/10 rounded-full blur-3xl pointer-events-none"></div>
          <div className="absolute -bottom-24 -right-24 w-80 h-80 bg-secondary/5 rounded-full blur-3xl pointer-events-none"></div>
          <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-space-lg">
            <div className="space-y-space-xs max-w-2xl">
              <div className="inline-flex items-center gap-space-xs px-3 py-1 rounded-full bg-primary-container/15 text-primary mb-2">
                <span className={`inline-block w-2 h-2 rounded-full bg-primary ${finished ? "" : "animate-pulse"}`}></span>
                <span className="font-label-sm text-label-sm tracking-wide">
                  {finished ? t("proc.stepDone") : t("proc.stepActive")}
                </span>
              </div>
              <h1 className="font-headline-lg text-headline-lg text-on-secondary-fixed tracking-tight">
                {t("proc.title")}
              </h1>
              <p className="font-body-md text-body-md text-on-surface-variant">
                {t("proc.subtitle")}
              </p>
            </div>
            {/* Overall progress ring & metrics */}
            <div className="bg-surface-container-low rounded-xl p-space-md flex items-center gap-space-lg min-w-[320px] shadow-sm">
              <div className="relative w-16 h-16 flex items-center justify-center shrink-0">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
                  <path
                    className="text-surface-variant"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3.5"
                  ></path>
                  <path
                    className="text-primary-container transition-all duration-700 ease-out"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                    fill="none"
                    stroke="currentColor"
                    strokeDasharray={`${pct}, 100`}
                    strokeLinecap="round"
                    strokeWidth="3.5"
                  ></path>
                </svg>
                <span className="absolute font-data-mono-lg text-data-mono-lg text-on-secondary-fixed font-bold">{pct}%</span>
              </div>
              <div className="flex flex-col gap-1 w-full">
                <div className="flex items-center justify-between text-on-surface-variant font-label-md text-label-md">
                  <span>{t("proc.overall")}</span>
                  <span className="font-data-mono-sm text-data-mono-sm text-primary font-medium">{etaText}</span>
                </div>
                <div className="w-full bg-surface-variant h-2.5 rounded-full overflow-hidden">
                  <div
                    className="rtl:bg-gradient-to-l ltr:bg-gradient-to-r from-primary-container to-primary h-full rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${pct}%` }}
                  ></div>
                </div>
                <div className="flex justify-between items-center pt-1 font-body-sm text-body-sm text-on-surface-variant">
                  <span>{t("proc.filesFed", { done: doneFiles, total: expected })}</span>
                  <span className="font-data-mono-sm text-data-mono-sm">
                    {t("proc.fieldsProgress", { done: fieldsDone, total: fieldsTotal })}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {batch.notice === "api_unavailable" && (
        <div className="w-full px-margin mb-space-md">
          <div className="max-w-[1440px] mx-auto flex items-start gap-2 rounded-xl bg-error-container text-on-error-container px-4 py-3 font-body-md text-body-md">
            <Icon name="cloud_off" className="text-[20px] shrink-0" />
            <span>{t("proc.apiDown")}</span>
          </div>
        </div>
      )}

      {/* Workspace grid: dual-pane layout */}
      <div className="w-full px-margin">
        <div className="max-w-[1440px] mx-auto grid grid-cols-1 lg:grid-cols-12 gap-gutter items-start">
          {/* Live scan visualizer */}
          <section className="lg:col-span-7 flex flex-col gap-space-md order-1">
            <div className="bg-surface-container-lowest rounded-[20px] shadow-[0_10px_30px_-5px_rgba(43,41,109,0.06)] p-space-md md:p-space-lg flex flex-col relative">
              <div className="flex items-center justify-between pb-space-sm mb-space-sm border-b-0">
                <div className="flex items-center gap-space-sm min-w-0">
                  <Icon name="document_scanner" className="text-primary text-[22px]" />
                  <div className="min-w-0">
                    <h3 className="font-headline-sm text-headline-sm text-on-secondary-fixed">{t("proc.liveTitle")}</h3>
                    <p className="font-body-sm text-body-sm text-on-surface-variant truncate" dir="auto">
                      {viewFile?.filename ?? t("proc.waitingFirst")}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 bg-primary-container/10 px-3 py-1.5 rounded-full text-primary shrink-0">
                  <span className="relative flex h-2 w-2">
                    {reading && (
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary-container opacity-75"></span>
                    )}
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                  </span>
                  <span className="font-label-sm text-label-sm font-bold">
                    {finished
                      ? t("proc.scanDone")
                      : batch.paused
                        ? t("proc.paused")
                        : slowForm
                          ? t("proc.slowForm")
                          : reading
                            ? t("proc.scanning", { page: (form?.page_index ?? 0) + 1, total: viewFile?.pages_total || 1 })
                            : t("proc.waitingNext")}
                  </span>
                </div>
              </div>

              <div className="relative w-full min-h-[320px] bg-surface-container-low rounded-xl overflow-hidden p-6 select-none shadow-inner flex flex-col items-center justify-center">
                <div className="absolute inset-0 bg-[radial-gradient(#2b296d_0.75px,transparent_0.75px)] [background-size:16px_16px] opacity-[0.04] pointer-events-none"></div>
                {form ? (
                  <div className="relative z-10 inline-block max-w-full shadow-sm bg-white rounded-lg">
                    <img
                      key={`${form.id}-${form.image_rev ?? 0}`}
                      src={api.imageUrl(form.id, form.image_rev)}
                      alt={t("proc.formAlt")}
                      className="block max-h-[560px] max-w-full w-auto h-auto rounded-lg"
                    />
                    {reading && (
                      <div
                        className="absolute inset-x-0 h-2 bg-gradient-to-r from-transparent via-primary-container to-transparent opacity-95 z-30 shadow-[0_0_18px_4px_rgba(43,185,155,0.7)]"
                        style={{ animation: "scanline 3.2s cubic-bezier(0.4, 0, 0.2, 1) infinite alternate" }}
                      ></div>
                    )}
                    {/* Frames around the fields the model found */}
                    {marked.map((n) => {
                      const fd = form.fields[n]!;
                      const [x0, y0, x1, y1] = fd.box!;
                      const review = fd.level === "review";
                      return (
                        <div
                          key={n}
                          className={`absolute rounded-lg z-20 pointer-events-none ${
                            review
                              ? "bg-tertiary-container/15 shadow-[0_0_0_2px_rgba(184,11,96,0.85)]"
                              : "bg-primary-container/10 shadow-[0_0_0_2px_rgba(43,185,155,0.85)]"
                          }`}
                          style={{
                            left: `${x0 * 100}%`,
                            top: `${y0 * 100}%`,
                            width: `${(x1 - x0) * 100}%`,
                            height: `${(y1 - y0) * 100}%`,
                          }}
                        >
                          <span
                            className={`absolute -top-3 left-3 text-on-primary font-data-mono-sm text-data-mono-sm px-2 py-0.5 rounded shadow whitespace-nowrap ${
                              review ? "bg-tertiary" : "bg-primary"
                            }`}
                          >
                            {fieldLabel(t, n)} {(fd.confidence * 100).toFixed(1)}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="relative z-10 flex flex-col items-center gap-2 text-on-surface-variant">
                    <Icon name="document_scanner" className="text-[48px] text-primary-container animate-pulse" />
                    <span className="font-body-md text-body-md">{t("proc.preparing")}</span>
                  </div>
                )}
              </div>

              <div className="relative z-10 flex items-center justify-between pt-3 text-on-surface-variant font-label-md text-label-md">
                <div className="flex items-center gap-2">
                  <Icon name="crop_free" className="text-[18px]" />
                  <span>
                    {form?.status === "done" ? t("proc.marked", { count: marked.length }) : t("proc.markHint")}
                  </span>
                </div>
                <div className="flex items-center gap-1 font-data-mono-sm text-data-mono-sm">
                  <span>{form ? t("proc.formNo", { id: form.id }) : ""}</span>
                  <span>•</span>
                  <span>OCR Engine: Claude Vision</span>
                </div>
              </div>
            </div>
          </section>

          {/* Per-file progress queue & live log */}
          <section className="lg:col-span-5 flex flex-col gap-space-md order-2">
            <div className="bg-surface-container-lowest rounded-[20px] shadow-[0_10px_30px_-5px_rgba(43,41,109,0.06)] p-space-md md:p-space-lg flex flex-col gap-space-md">
              <div className="flex items-center justify-between pb-space-xs">
                <div className="flex items-center gap-space-xs">
                  <Icon name="format_list_bulleted" className="text-secondary text-[22px]" />
                  <h2 className="font-headline-sm text-headline-sm text-on-secondary-fixed">{t("proc.queueTitle")}</h2>
                </div>
                <span className="bg-surface-container px-2.5 py-0.5 rounded-full font-data-mono-sm text-data-mono-sm text-on-surface-variant font-medium">
                  {t("unit.documents", { count: batch.files.length })}
                </span>
              </div>
              {batch.files.map((f) => (
                <FileItem key={f.id} f={f} />
              ))}
              {uploadsPending > 0 && (
                <div className="flex items-center gap-2 rounded-xl p-space-md bg-surface-container-low/40 font-body-sm text-body-sm text-on-surface-variant">
                  <Icon name="cloud_upload" className="text-[18px] animate-pulse" />
                  {t("proc.uploadsPending", { count: uploadsPending })}
                </div>
              )}
              {skipped > 0 && (
                <div className="flex items-center gap-2 font-body-sm text-body-sm text-on-surface-variant">
                  <Icon name="block" className="text-[16px]" />
                  {t("proc.skipped", { count: skipped })}
                </div>
              )}
            </div>

            <div className="bg-surface-container-lowest rounded-[20px] shadow-[0_10px_30px_-5px_rgba(43,41,109,0.06)] p-space-md flex flex-col gap-2">
              <div className="flex items-center justify-between border-b border-surface-variant/40 pb-2">
                <div className="flex items-center gap-2">
                  <Icon name="terminal" className="text-secondary text-[18px]" />
                  <span className="font-label-md text-label-md text-on-secondary-fixed font-bold">{t("proc.logTitle")}</span>
                </div>
                <span className="inline-block w-2 h-2 rounded-full bg-primary-container"></span>
              </div>
              <div className="bg-surface-container-low rounded-lg p-3 font-data-mono-sm text-data-mono-sm text-on-secondary-container flex flex-col gap-1.5 max-h-40 overflow-hidden leading-relaxed">
                {log.length === 0 && <span className="opacity-70">{t("proc.logWaiting")}</span>}
                {log.slice(-4).map((l, i, arr) => {
                  const last = i === arr.length - 1;
                  const failure = l.params?.error ? String(l.params.error) : "";
                  const params =
                    l.key === "log.fileFailed"
                      ? { ...l.params, error: failure ? errorText(t, failure, failure) : t("log.error") }
                      : l.params;
                  const text = t(l.key, params);
                  return (
                    <div
                      key={`${l.at}-${l.key}-${i}`}
                      className={`flex items-center gap-2 ${last ? "text-primary font-medium" : i === arr.length - 2 ? "opacity-90" : "opacity-70"}`}
                    >
                      <span className="text-secondary" dir="ltr">
                        [{new Date(l.at).toLocaleTimeString(locale, { hour12: false })}]
                      </span>
                      <span className={last && !finished ? "animate-pulse" : ""}>{text}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {!finished && (
              <label className="flex items-center gap-2 font-body-sm text-body-sm text-on-surface-variant cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="accent-primary w-4 h-4"
                  checked={stay}
                  onChange={(e) => {
                    setStay(e.target.checked);
                    writeStay(e.target.checked);
                  }}
                />
                {t("live.stayHere")}
              </label>
            )}
            <div className="flex flex-col sm:flex-row items-center gap-space-sm pt-space-xs">
              {/* Finished forms can be reviewed and fixed while the rest of the batch is still being read */}
              {!finished && readyForReview > 0 ? (
                <Link
                  to={`/batches/${batchId}`}
                  title={t("proc.reviewReady", { count: readyForReview })}
                  className="w-full sm:flex-1 py-3 px-space-md rounded-[10px] bg-primary text-on-primary font-bold flex items-center justify-center gap-space-sm shadow-sm hover:bg-primary/90 transition-colors"
                >
                  <Icon name="fact_check" className="text-[20px]" />
                  <span className="font-headline-sm text-headline-sm">{t("proc.startReview")}</span>
                  <span className="bg-on-primary/20 px-2 py-0.5 rounded-full font-data-mono-sm text-data-mono-sm">
                    {readyForReview}
                  </span>
                </Link>
              ) : (
                <button
                  className="w-full sm:flex-1 py-3 px-space-md rounded-[10px] bg-primary text-on-primary font-bold flex items-center justify-center gap-space-sm opacity-90 cursor-wait shadow-sm"
                  disabled
                  type="button"
                >
                  {!finished && !batch.paused && (
                    <svg className="animate-spin h-5 w-5 text-on-primary" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" fill="currentColor"></path>
                    </svg>
                  )}
                  <span className="font-headline-sm text-headline-sm">
                    {finished ? t("proc.toReview") : batch.paused ? t("proc.paused") : t("proc.working")}
                  </span>
                </button>
              )}
              <button
                className="w-full sm:w-auto py-3 px-space-md rounded-[10px] bg-surface-container-lowest text-secondary font-bold hover:bg-surface-container transition-all flex items-center justify-center gap-space-xs shadow-sm disabled:opacity-50"
                disabled={busy || finished}
                onClick={() => act(() => (batch.paused ? api.resumeBatch(batchId) : api.pauseBatch(batchId)))}
                type="button"
              >
                <Icon name={batch.paused ? "play_circle" : "pause_circle"} className="text-[20px]" />
                <span className="font-headline-sm text-headline-sm">{batch.paused ? t("proc.resume") : t("proc.pause")}</span>
              </button>
              <button
                className="w-full sm:w-auto py-3 px-space-md rounded-[10px] bg-transparent text-tertiary hover:bg-tertiary-container/10 transition-all font-bold flex items-center justify-center gap-space-xs disabled:opacity-50"
                disabled={busy || finished}
                onClick={cancel}
                type="button"
              >
                <Icon name="close" className="text-[20px]" />
                <span className="font-headline-sm text-headline-sm">{t("proc.cancel")}</span>
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function FileItem({ f }: { f: SourceFileData }) {
  const { t } = useI18n();
  const done = f.status === "done";
  const failed = f.status === "failed";
  const queued = f.status === "pending";
  const active = f.status === "processing";
  const pct = done ? 1 : f.progress;

  const box = active
    ? "bg-surface-container-low shadow-sm relative overflow-hidden"
    : done || failed
      ? "bg-surface-container-low/70"
      : "bg-surface-container-low/40 opacity-75";
  const iconBox = failed
    ? "bg-error-container text-error"
    : queued
      ? "bg-surface-variant text-on-surface-variant"
      : done
        ? "bg-primary-container/15 text-primary"
        : "bg-primary-container/20 text-primary";
  const icon = failed ? "error" : done ? "task_alt" : queued ? "hourglass_empty" : "description";
  const trackCls = done ? "bg-primary/20" : "bg-surface-variant";
  const fillCls = failed ? "bg-error" : done ? "bg-primary" : queued ? "bg-surface-dim" : "bg-primary-container";

  return (
    <div className={`rounded-xl p-space-md flex flex-col gap-space-xs ${box}`}>
      {active && (
        <div className="absolute top-0 right-0 left-0 h-1 bg-gradient-to-r from-primary-container via-primary to-primary-container animate-pulse"></div>
      )}
      <div className="flex items-start justify-between gap-space-xs">
        <div className="flex items-center gap-space-sm min-w-0">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${iconBox}`}>
            <Icon name={icon} className="text-[20px]" />
          </div>
          <div className="min-w-0">
            <h4 className="font-body-md text-body-md font-bold text-on-secondary-fixed truncate" dir="auto">
              {f.filename}
            </h4>
            {active && (
              <div className="flex items-center gap-2 font-body-sm text-body-sm text-on-surface-variant">
                <span className="flex h-2 w-2 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                </span>
                <span>{t("file.active")}</span>
              </div>
            )}
            {done && (
              <span className="inline-flex items-center gap-1 font-label-sm text-label-sm text-primary font-bold">
                <Icon name="check" className="text-[14px]" />
                {t("file.done")}
              </span>
            )}
            {failed && (
              <span className="font-body-sm text-body-sm text-error" dir="auto">
                {f.error_code || f.error ? errorText(t, f.error_code, f.error) : t("file.failed")}
              </span>
            )}
            {(f.warnings ?? []).map((w) => (
              <span key={w} className="block font-body-sm text-body-sm text-tertiary">
                {warningLabel(t, w)}
              </span>
            ))}
            {f.duplicate_of_batch && (
              <Link
                to={`/batches/${f.duplicate_of_batch}`}
                className="block font-body-sm text-body-sm text-tertiary underline"
              >
                {t("warn.duplicate", { id: f.duplicate_of_batch })}
              </Link>
            )}
            {queued && <span className="font-body-sm text-body-sm text-on-surface-variant">{t("file.queued")}</span>}
          </div>
        </div>
        <span className={`font-data-mono-lg text-data-mono-lg font-bold shrink-0 ${queued ? "text-on-surface-variant" : "text-primary"}`}>
          {Math.round(pct * 100)}%
        </span>
      </div>
      <div className={`w-full h-2 rounded-full overflow-hidden mt-1 ${trackCls}`}>
        <div
          className={`h-full rounded-full transition-all duration-300 ${fillCls}`}
          style={{ width: `${Math.round(pct * 100)}%` }}
        ></div>
      </div>
      <div className="flex items-center justify-between text-body-sm font-body-sm text-on-surface-variant pt-1">
        <span className={`font-data-mono-sm text-data-mono-sm ${queued ? "" : "text-primary"}`}>
          {queued
            ? t("file.waitQueue")
            : done
              ? t("file.extracted", { count: f.fields_extracted })
              : t("file.extractedOf", { done: f.fields_extracted, total: f.fields_total || "—" })}
        </span>
        <span className="font-data-mono-sm text-data-mono-sm">
          {queued
            ? t("file.next")
            : done && f.avg_confidence !== null
              ? t("file.accuracy", { pct: `${(f.avg_confidence * 100).toFixed(1)}%` })
              : f.pages_total
                ? t("file.page", { page: Math.min(f.pages_done + 1, f.pages_total), total: f.pages_total })
                : ""}
        </span>
      </div>
    </div>
  );
}
