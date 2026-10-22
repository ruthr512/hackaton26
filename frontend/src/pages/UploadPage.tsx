import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, NetworkError, type UploadHandle } from "@/lib/api";
import { errorText } from "@/lib/labels";
import { useI18n } from "@/i18n";

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.tiff,.tif,.heic,.heif";
const ACCEPT_RE = /\.(pdf|png|jpe?g|tiff?|heic|heif)$/i;
const MAX_FILE_MB = 50;
const MAX_FILES = 50;
const PARALLEL_UPLOADS = 2;
const MAX_ATTEMPTS = 3;
const SLOW_AFTER_MS = 8_000; // no progress this long: tell the user the connection is slow
const STALL_AFTER_MS = 30_000; // no progress this long: give up on this attempt and retry the file

type UploadStatus = "ready" | "uploading" | "retrying" | "uploaded" | "rejected" | "failed";

interface QueueItem {
  key: string;
  file: File;
  ext: string;
  previewUrl: string | null;
  pages: number | null;
  /** Problem spotted before upload (the server decides; this only warns). */
  warn?: "pdfUnreadable" | "encrypted";
  status: UploadStatus;
  progress: number;
  attempt: number;
  slow: boolean;
  /** Why the server refused the file (empty_file, unsupported_type...) or the upload failed. */
  errorCode?: string | null;
  errorMessage?: string;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/** Best-effort look inside a PDF: page count (null when it can't be read) and whether it is encrypted. */
async function inspectPdf(file: File): Promise<{ pages: number | null; encrypted: boolean }> {
  try {
    const text = new TextDecoder("latin1").decode(await file.arrayBuffer());
    const tree = [...text.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
    const leaves = (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
    const n = Math.max(leaves, ...tree, 0);
    return { pages: n > 0 ? n : null, encrypted: /\/Encrypt\s/.test(text) };
  } catch {
    return { pages: null, encrypted: false };
  }
}

function Icon({ name, className }: { name: string; className: string }) {
  return <span className={`material-symbols-outlined ${className}`}>{name}</span>;
}

export function UploadPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState([true, true, true]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const batchRef = useRef<number | null>(null); // the open batch the files go into
  const handles = useRef(new Map<string, UploadHandle>());
  const cancelled = useRef(false);
  const statusOf = useRef(new Map<string, UploadStatus>()); // read right away, before React re-renders

  // Release preview URLs on unmount.
  useEffect(
    () => () => queueRef.current.forEach((q) => q.previewUrl && URL.revokeObjectURL(q.previewUrl)),
    [],
  );

  function addFiles(list: FileList | null) {
    if (!list) return;
    const all = Array.from(list);
    const empty = all.filter((f) => f.size === 0);
    const supported = all.filter((f) => ACCEPT_RE.test(f.name) && f.size > 0);
    const tooBig = supported.filter((f) => f.size > MAX_FILE_MB * 1024 * 1024);
    const fresh = supported
      .filter((f) => f.size <= MAX_FILE_MB * 1024 * 1024)
      .filter((f) => !queue.some((q) => q.file.name === f.name && q.file.size === f.size));
    const room = MAX_FILES - queue.length;
    const accepted = fresh.slice(0, Math.max(room, 0));

    const problems: string[] = [];
    const rejected = all.length - supported.length - empty.length;
    if (rejected) problems.push(t("upload.errUnsupported", { count: rejected }));
    if (empty.length) problems.push(t("upload.errEmpty", { count: empty.length }));
    if (tooBig.length) problems.push(t("upload.errTooBig", { count: tooBig.length, max: MAX_FILE_MB }));
    if (fresh.length > accepted.length) problems.push(t("upload.errTooMany", { max: MAX_FILES }));
    setError(problems.length ? problems.join(" · ") : null);

    const items: QueueItem[] = accepted.map((file) => {
      const ext = (file.name.split(".").pop() ?? "").toUpperCase().replace("JPEG", "JPG").replace("TIFF", "TIF");
      const isImage = /^(png|jpe?g)$/i.test(ext);
      return {
        key: `${file.name}:${file.size}:${file.lastModified}`,
        file,
        ext,
        previewUrl: URL.createObjectURL(file),
        pages: isImage ? 1 : null,
        status: "ready",
        progress: 0,
        attempt: 0,
        slow: false,
      };
    });
    setQueue((prev) => [...prev, ...items]);
    items
      .filter((i) => i.ext === "PDF")
      .forEach(async (i) => {
        const { pages, encrypted } = await inspectPdf(i.file);
        const warn = encrypted ? ("encrypted" as const) : pages === null ? ("pdfUnreadable" as const) : undefined;
        setQueue((prev) => prev.map((q) => (q.key === i.key ? { ...q, pages, warn } : q)));
      });
  }

  function patch(key: string, values: Partial<QueueItem>) {
    if (values.status) statusOf.current.set(key, values.status);
    setQueue((prev) => prev.map((q) => (q.key === key ? { ...q, ...values } : q)));
  }

  /** One attempt; a stalled upload (no progress for a while) is aborted so it can be retried. */
  function uploadWithWatchdog(key: string, file: File) {
    return new Promise<Awaited<UploadHandle["promise"]>>((resolve, reject) => {
      let last = Date.now();
      let sent = 0;
      const h = api.uploadFile(batchRef.current!, file, (f) => {
        last = Date.now();
        sent = f;
        patch(key, { progress: f, slow: false });
      });
      handles.current.set(key, h);
      const timer = window.setInterval(() => {
        const idle = Date.now() - last;
        // once every byte is out, the server only stores the file: allow it more time to answer
        if (idle > (sent >= 1 ? STALL_AFTER_MS * 2 : STALL_AFTER_MS)) h.abort();
        else if (idle > SLOW_AFTER_MS) patch(key, { slow: true });
      }, 1000);
      h.promise.then(resolve, reject).finally(() => {
        window.clearInterval(timer);
        handles.current.delete(key);
      });
    });
  }

  /** Upload one file, retrying with backoff; a refusal by the server (bad file) is not retried. */
  async function uploadOne(key: string) {
    const item = queueRef.current.find((q) => q.key === key);
    if (!item) return;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !cancelled.current; attempt++) {
      patch(key, { status: attempt > 1 ? "retrying" : "uploading", attempt, progress: 0, slow: false });
      try {
        const res = await uploadWithWatchdog(key, item.file);
        patch(key, {
          status: res.status === "failed" ? "rejected" : "uploaded",
          progress: 1,
          slow: false,
          errorCode: res.error_code,
        });
        return;
      } catch (e) {
        if (cancelled.current) return;
        if (e instanceof ApiError && e.status < 500) {
          patch(key, { status: "failed", slow: false, errorCode: e.code, errorMessage: e.message });
          return;
        }
        if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
      }
    }
    if (!cancelled.current) patch(key, { status: "failed", slow: false });
  }

  async function uploadAll(keys: string[]) {
    setUploading(true);
    const todo = [...keys];
    const worker = async () => {
      while (todo.length && !cancelled.current) await uploadOne(todo.shift()!);
    };
    await Promise.all(Array.from({ length: PARALLEL_UPLOADS }, worker));
    if (cancelled.current) return;
    setUploading(false);
    // every file arrived (or was refused by the server with a reason): processing is already running
    if (![...statusOf.current.values()].includes("failed")) navigate(`/batches/${batchRef.current}/processing`);
  }

  async function retryFailedUploads() {
    setError(null);
    await uploadAll([...statusOf.current].filter(([, st]) => st === "failed").map(([key]) => key));
  }

  /** Give up on the files that did not arrive; the batch finishes with the ones that did. */
  async function continueWithout() {
    if (batchRef.current === null) return;
    try {
      await api.closeBatch(batchRef.current);
    } catch (e) {
      return setError(e instanceof NetworkError ? t("common.networkError") : (e as Error).message);
    }
    navigate(`/batches/${batchRef.current}/processing`);
  }

  async function cancelUpload() {
    if (!window.confirm(t("upload.cancelConfirm"))) return;
    cancelled.current = true;
    handles.current.forEach((h) => h.abort());
    const arrived = [...statusOf.current.values()].includes("uploaded");
    if (batchRef.current !== null) await api.closeBatch(batchRef.current).catch(() => {});
    if (arrived && batchRef.current !== null) return navigate(`/batches/${batchRef.current}/processing`);
    batchRef.current = null;
    statusOf.current.clear();
    setUploading(false);
    setQueue((prev) =>
      prev.map((q) => ({ ...q, status: "ready", progress: 0, attempt: 0, slow: false, errorCode: null, errorMessage: undefined })),
    );
  }

  function remove(key: string) {
    setQueue((prev) => {
      prev.filter((q) => q.key === key).forEach((q) => q.previewUrl && URL.revokeObjectURL(q.previewUrl));
      return prev.filter((q) => q.key !== key);
    });
  }

  function clearQueue() {
    queue.forEach((q) => q.previewUrl && URL.revokeObjectURL(q.previewUrl));
    setQueue([]);
    setError(null);
  }

  /** Each file is its own request: a slow or broken one is retried alone, and the server starts reading
   * every file as soon as it arrives instead of waiting for the whole batch. */
  async function start() {
    if (!queue.length || uploading) return;
    if (batchRef.current !== null) return retryFailedUploads();
    setError(null);
    cancelled.current = false;
    setUploading(true);
    try {
      batchRef.current = (await api.openBatch(queue.length)).id;
    } catch (e) {
      setError(e instanceof NetworkError ? t("common.networkError") : (e as Error).message);
      setUploading(false);
      return;
    }
    await uploadAll(queue.map((q) => q.key));
  }

  const failedUploads = queue.filter((q) => q.status === "failed").length;
  const uploadFraction = queue.length
    ? queue.reduce((n, q) => n + (q.status === "ready" ? 0 : q.progress), 0) / queue.length
    : 0;
  const knownPages = queue.reduce((n, q) => n + (q.pages ?? 0), 0);
  const allPagesKnown = queue.every((q) => q.pages !== null);
  const pagesCount = t("unit.pages", { count: Math.max(knownPages, queue.length ? 1 : 0) });
  const pagesLabel = allPagesKnown ? pagesCount : t("upload.atLeast", { value: pagesCount });

  const settingsDefs = [
    { title: t("upload.settingIcr"), sub: t("upload.settingIcrSub") },
    { title: t("upload.settingIcd"), sub: t("upload.settingIcdSub") },
    { title: t("upload.settingSchema"), sub: t("upload.settingSchemaSub") },
  ];

  const badges = [
    { icon: "verified", title: t("upload.badgeAccuracy"), sub: t("upload.badgeAccuracySub") },
    { icon: "speed", title: t("upload.badgeSpeed"), sub: t("upload.badgeSpeedSub") },
    { icon: "table_view", title: t("upload.badgeExport"), sub: t("upload.badgeExportSub") },
  ];

  return (
    <div className="w-full max-w-[1400px] mx-auto px-margin py-space-lg flex flex-col gap-space-xl">
      {/* Top Step Progress & Clinical Breadcrumb Strip */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-space-md">
        <div className="flex items-center gap-space-sm bg-surface-container-lowest px-4 py-2 rounded-full shadow-sm">
          <span className="flex h-2.5 w-2.5 rounded-full bg-primary-container animate-pulse"></span>
          <span className="font-label-sm text-label-sm text-on-surface-variant font-bold uppercase tracking-wider">{t("upload.processLabel")}</span>
          <span className="text-on-surface-variant/40 font-data-mono-sm text-data-mono-sm">/</span>
          <span className="font-label-sm text-label-sm text-secondary font-bold">{t("upload.stepLabel")}</span>
        </div>
        <div className="flex items-center gap-space-md">
          <div className="hidden sm:flex items-center gap-1.5 text-on-surface-variant font-body-sm text-body-sm">
            <Icon name="security" className="text-[18px] text-primary" />
            <span>{t("upload.encrypted")}</span>
          </div>
        </div>
      </div>

      {/* Editorial Intro & Page Heading Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-space-lg">
        <div className="flex flex-col max-w-3xl">
          <div className="flex items-center gap-2 mb-2">
            <span className="font-data-mono-sm text-data-mono-sm uppercase text-primary font-medium tracking-wide">
              OCR &amp; ICR ENGINE • BATCH INGESTION
            </span>
          </div>
          <h1 className="font-display-lg text-display-lg text-secondary tracking-tight font-extrabold mb-3">
            {t("upload.title")}
          </h1>
          <p className="font-body-lg text-body-lg text-on-surface-variant leading-relaxed">
            {t("upload.intro")}
          </p>
        </div>
        <div className="flex items-center gap-3 self-start md:self-auto bg-surface-container-low p-2 rounded-2xl">
          {[
            { icon: "description", label: t("upload.typeForm17") },
            { icon: "biotech", label: t("upload.typeLab") },
            { icon: "history_edu", label: t("upload.typeDischarge") },
          ].map((d) => (
            <div key={d.icon} className="flex items-center gap-2 px-3 py-2 bg-surface-container-lowest rounded-xl shadow-sm text-secondary">
              <Icon name={d.icon} className="text-[20px] text-primary-container" />
              <span className="font-label-md text-label-md font-bold">{d.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Main Dropzone Container Card */}
      <div
        id="dropzone"
        onClick={(e) => {
          if (e.target !== inputRef.current) inputRef.current?.click();
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        className={`relative group bg-surface-container-lowest rounded-[20px] shadow-[0_10px_30px_-5px_rgba(43,41,109,0.07)] p-space-lg sm:p-space-xl transition-all duration-300 hover:shadow-[0_18px_38px_-6px_rgba(43,41,109,0.12)] cursor-pointer overflow-hidden${
          dragging ? " ring-4 ring-primary-container/30 scale-[1.005]" : ""
        }`}
      >
        <div className="absolute -top-24 -left-24 w-80 h-80 bg-primary-fixed/30 rounded-full blur-3xl pointer-events-none transition-transform group-hover:scale-125 duration-700"></div>
        <div className="absolute -bottom-24 -right-24 w-80 h-80 bg-secondary-fixed/25 rounded-full blur-3xl pointer-events-none transition-transform group-hover:scale-125 duration-700"></div>
        <div className="relative w-full rounded-[16px] bg-gradient-to-b from-primary-fixed/10 via-transparent to-surface-container-low/40 p-8 sm:p-12 flex flex-col items-center justify-center text-center">
          <div className="relative mb-6">
            <div className="absolute inset-0 rounded-full bg-primary-container/20 animate-ping"></div>
            <div className="relative w-20 h-20 rounded-full bg-surface-container-lowest shadow-[0_8px_20px_rgba(43,185,155,0.25)] flex items-center justify-center text-primary-container transition-transform duration-300 group-hover:scale-110">
              <Icon name="cloud_upload" className="text-[40px]" />
            </div>
          </div>
          <h2 className="font-headline-lg text-headline-lg text-secondary font-bold mb-2">{t("upload.dropTitle")}</h2>
          <p className="font-body-md text-body-md text-on-surface-variant max-w-lg mb-6">
            {t("upload.dropHint")}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 mb-6">
            {[
              { icon: "picture_as_pdf", text: "PDF" },
              { icon: "image", text: "TIFF / PNG / JPG" },
              { icon: "layers", text: t("upload.maxPerFile", { max: MAX_FILE_MB }) },
              { icon: "dynamic_feed", text: t("upload.batchMax", { max: MAX_FILES }) },
            ].map((b) => (
              <span
                key={b.text}
                className="px-3 py-1.5 rounded-full bg-surface-container font-label-md text-label-md text-on-surface font-medium flex items-center gap-1.5"
              >
                <Icon name={b.icon} className="text-[16px] text-primary" />
                {b.text}
              </span>
            ))}
          </div>
          <input
            ref={inputRef}
            accept={ACCEPT}
            className="hidden"
            id="fileUpload"
            multiple
            type="file"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            className="bg-primary-container hover:bg-[#249F85] text-on-primary font-headline-sm text-headline-sm px-8 py-3.5 rounded-xl shadow-[0_10px_20px_-3px_rgba(43,185,155,0.4)] transition-all duration-200 flex items-center gap-2 font-bold cursor-pointer hover:translate-y-[-1px]"
            type="button"
          >
            <Icon name="add_circle" className="text-[22px]" />
            <span>{t("upload.choose")}</span>
          </button>
          <div className="mt-8 flex items-center justify-center gap-2 text-on-surface-variant font-body-sm text-body-sm bg-surface-container-lowest/80 px-4 py-2 rounded-full shadow-sm">
            <Icon name="lock_reset" className="text-[16px] text-primary" />
            <span>{t("upload.privacy")}</span>
          </div>
        </div>
      </div>

      {/* Batch Upload Queue Section */}
      <div className="flex flex-col gap-space-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-space-sm">
            <h3 className="font-headline-md text-headline-md text-secondary font-bold">{t("upload.queueTitle")}</h3>
            <span className="bg-secondary/10 text-secondary font-data-mono-sm text-data-mono-sm px-2.5 py-0.5 rounded-full font-bold">
              {t("unit.documents", { count: queue.length })}
            </span>
          </div>
          <div className="flex items-center gap-space-md">
            <button
              className="text-on-surface-variant hover:text-tertiary transition-colors font-label-md text-label-md flex items-center gap-1 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
              disabled={uploading || batchRef.current !== null}
              onClick={clearQueue}
              type="button"
            >
              <Icon name="delete_sweep" className="text-[18px]" />
              <span>{t("upload.clearAll")}</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 bg-tertiary-fixed text-on-tertiary-fixed-variant font-label-md text-label-md font-bold px-4 py-2 rounded-full self-start">
            <Icon name="error" className="text-[18px]" />
            <span>{error}</span>
          </div>
        )}

        {!uploading && failedUploads > 0 && (
          <div className="flex flex-wrap items-center gap-space-sm bg-error-container text-on-error-container font-label-md text-label-md px-4 py-2 rounded-2xl self-start">
            <Icon name="cloud_off" className="text-[18px]" />
            <span className="font-bold">{t("upload.someFailed", { count: failedUploads })}</span>
            <button type="button" className="underline font-bold" onClick={retryFailedUploads}>
              {t("upload.retryFailed")}
            </button>
            <button type="button" className="underline" onClick={continueWithout}>
              {t("upload.continueWithout")}
            </button>
          </div>
        )}

        <div className="flex flex-col gap-space-sm" id="queueList">
          {queue.length === 0 && (
            <div className="p-8 text-center bg-surface-container-lowest rounded-[20px] shadow-sm flex flex-col items-center justify-center gap-2">
              <Icon name="inventory_2" className="text-[36px] text-outline-variant" />
              <span className="font-headline-sm text-headline-sm text-secondary font-bold">{t("upload.emptyTitle")}</span>
              <span className="font-body-sm text-body-sm text-on-surface-variant">{t("upload.emptyHint")}</span>
            </div>
          )}
          {queue.map((q) => {
            const isPdf = q.ext === "PDF";
            const isImage = /^(PNG|JPG)$/.test(q.ext);
            return (
              <div
                key={q.key}
                className="group bg-surface-container-lowest rounded-[20px] p-4 sm:p-5 shadow-[0_8px_24px_-4px_rgba(43,41,109,0.05)] hover:shadow-[0_12px_28px_-4px_rgba(43,41,109,0.09)] transition-all flex flex-col md:flex-row items-start md:items-center justify-between gap-4"
              >
                <div className="flex items-center gap-4 w-full md:w-auto">
                  <div className="relative w-14 h-16 rounded-xl bg-surface-container overflow-hidden shrink-0 flex items-center justify-center shadow-inner">
                    {isImage && q.previewUrl ? (
                      <img className="w-full h-full object-cover" alt="" src={q.previewUrl} />
                    ) : (
                      <Icon name={isPdf ? "picture_as_pdf" : "image"} className="text-[28px] text-secondary" />
                    )}
                    <span className="absolute bottom-1 end-1 bg-secondary/80 text-on-secondary text-[9px] px-1 rounded font-data-mono-sm">
                      {q.ext}
                    </span>
                  </div>
                  <div className="flex flex-col min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className="font-headline-sm text-headline-sm text-secondary font-bold truncate max-w-[280px] sm:max-w-md" dir="auto">
                        {q.file.name}
                      </span>
                      <span
                        className={`px-2.5 py-0.5 rounded-full font-label-sm text-label-sm font-bold ${
                          isPdf ? "bg-primary/10 text-primary" : "bg-secondary/10 text-secondary"
                        }`}
                      >
                        {isPdf ? t("upload.pdfDoc") : t("upload.scannedImage")}
                      </span>
                    </div>
                    {(q.warn || q.errorCode || q.errorMessage) && (
                      <span
                        className={`font-body-sm text-body-sm mb-1 ${q.status === "rejected" || q.status === "failed" ? "text-error" : "text-tertiary"}`}
                      >
                        {q.errorCode || q.errorMessage
                          ? errorText(t, q.errorCode, q.errorMessage)
                          : q.warn === "encrypted"
                            ? t("upload.warnEncrypted")
                            : t("upload.warnPdfUnreadable")}
                      </span>
                    )}
                    <div className="flex flex-wrap items-center gap-space-md text-on-surface-variant font-body-sm text-body-sm">
                      <span className="flex items-center gap-1">
                        <span>{t("upload.fileSize")}</span>
                        <span className="font-data-mono-sm text-data-mono-sm font-medium text-on-surface" dir="ltr">{mb(q.file.size)} MB</span>
                      </span>
                      {q.pages !== null && (
                        <span className="flex items-center gap-1">
                          <Icon name="auto_stories" className="text-[15px] text-on-surface-variant" />
                          <span>{t("unit.pages", { count: q.pages })}</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between md:justify-end gap-space-md w-full md:w-auto">
                  <StatusPill q={q} />
                  <div className="flex items-center gap-1">
                    <button
                      className="w-9 h-9 rounded-full bg-surface-container-low hover:bg-surface-container flex items-center justify-center text-secondary transition-colors"
                      onClick={() => q.previewUrl && window.open(q.previewUrl, "_blank")}
                      title={t("upload.preview")}
                      type="button"
                    >
                      <Icon name="visibility" className="text-[18px]" />
                    </button>
                    <button
                      className="w-9 h-9 rounded-full bg-surface-container-low hover:bg-error-container text-on-surface-variant hover:text-error flex items-center justify-center transition-colors disabled:opacity-30 disabled:pointer-events-none"
                      disabled={uploading || batchRef.current !== null}
                      onClick={() => remove(q.key)}
                      title={t("upload.remove")}
                      type="button"
                    >
                      <Icon name="delete" className="text-[18px]" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Extraction Parameters & Settings Strip */}
      <div className="bg-surface-container-lowest rounded-[20px] p-6 shadow-[0_10px_30px_-5px_rgba(43,41,109,0.06)] flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
        <div className="flex flex-col">
          <div className="flex items-center gap-2 mb-1">
            <Icon name="tune" className="text-secondary text-[20px]" />
            <span className="font-headline-sm text-headline-sm text-secondary font-bold">{t("upload.settingsTitle")}</span>
          </div>
          <p className="font-body-sm text-body-sm text-on-surface-variant">{t("upload.settingsHint")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-space-lg">
          {settingsDefs.map((d, i) => (
            <label key={d.title} className="flex items-center gap-3 cursor-pointer group select-none">
              <div className="relative flex items-center">
                <input
                  checked={settings[i]}
                  onChange={(e) => setSettings((prev) => prev.map((v, j) => (j === i ? e.target.checked : v)))}
                  className="peer sr-only"
                  type="checkbox"
                />
                <div className="w-5 h-5 bg-surface-container rounded-md peer-checked:bg-primary-container transition-all flex items-center justify-center shadow-inner">
                  <Icon name="check" className="text-[16px] text-on-primary opacity-0 peer-checked:opacity-100 transition-opacity" />
                </div>
              </div>
              <div className="flex flex-col">
                <span className="font-label-md text-label-md text-secondary font-bold group-hover:text-primary transition-colors">{d.title}</span>
                <span className="font-body-sm text-body-sm text-on-surface-variant">{d.sub}</span>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Bottom Action Bar */}
      <div className="bg-surface-container-lowest rounded-[20px] p-6 shadow-[0_14px_34px_-6px_rgba(43,41,109,0.10)] flex flex-col sm:flex-row items-center justify-between gap-space-lg mb-space-lg">
        <div className="flex items-center gap-4 w-full sm:w-auto">
          <div className="w-12 h-12 rounded-2xl bg-secondary/10 flex items-center justify-center text-secondary shrink-0">
            <Icon name="task" className="text-[26px]" />
          </div>
          <div className="flex flex-col">
            <span className="font-headline-sm text-headline-sm text-secondary font-bold">{t("upload.selected", { count: queue.length })}</span>
            <span className="font-body-sm text-body-sm text-on-surface-variant">
              {t("upload.totalPrefix")} <strong className="font-data-mono-sm text-data-mono-sm text-secondary">{pagesLabel}</strong>{" "}
              {t("upload.totalSuffix")}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-space-md w-full sm:w-auto justify-end">
          {uploading ? (
            <button
              className="px-6 py-3.5 rounded-xl font-headline-sm text-headline-sm text-tertiary hover:bg-tertiary-container/10 transition-colors font-bold cursor-pointer"
              onClick={cancelUpload}
              type="button"
            >
              {t("upload.cancel")}
            </button>
          ) : (
            <button
              className="px-6 py-3.5 rounded-xl font-headline-sm text-headline-sm text-secondary hover:bg-surface-container-low transition-colors font-bold cursor-pointer disabled:opacity-40"
              disabled={batchRef.current !== null}
              onClick={clearQueue}
              type="button"
            >
              {t("upload.clearList")}
            </button>
          )}
          <a
            href="#"
            role="button"
            aria-disabled={!queue.length || uploading}
            onClick={(e) => {
              e.preventDefault();
              start();
            }}
            className="flex-1 sm:flex-none bg-primary-container hover:bg-[#249F85] text-on-primary font-headline-sm text-headline-sm px-8 py-3.5 rounded-xl shadow-[0_12px_24px_-4px_rgba(43,185,155,0.45)] transition-all duration-200 flex items-center justify-center gap-3 font-bold cursor-pointer hover:translate-y-[-2px] group aria-disabled:opacity-50 aria-disabled:pointer-events-none"
          >
            <span>
              {uploading
                ? t("upload.uploading", { pct: Math.round(uploadFraction * 100) })
                : batchRef.current !== null && failedUploads > 0
                  ? t("upload.retryFailed")
                  : t("upload.start")}
            </span>
            <Icon name="cloud_upload" className="text-[22px] transition-transform rtl:group-hover:-translate-x-1 ltr:group-hover:translate-x-1" />
          </a>
        </div>
      </div>

      {/* Trust & Performance Badges Banner */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-space-md pt-2 pb-6">
        {badges.map((b) => (
          <div key={b.title} className="flex items-start gap-3 p-4 rounded-2xl bg-surface-container-low">
            <Icon name={b.icon} className="text-primary text-[24px]" />
            <div className="flex flex-col">
              <span className="font-label-md text-label-md text-secondary font-bold">{b.title}</span>
              <span className="font-body-sm text-body-sm text-on-surface-variant">{b.sub}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Where one file stands: ready, uploading (or slow / retrying), uploaded, refused by the server, failed. */
function StatusPill({ q }: { q: QueueItem }) {
  const { t } = useI18n();
  const pct = Math.round(q.progress * 100);
  const calm = "bg-primary-fixed/20 text-on-primary-fixed-variant";
  const warm = "bg-tertiary-container/30 text-on-tertiary-container";
  const bad = "bg-error-container text-error";
  const [cls, dot, label] =
    q.status === "uploaded"
      ? ["bg-primary-container/20 text-primary", "bg-primary", t("upload.stUploaded")]
      : q.status === "rejected"
        ? [bad, "bg-error", t("upload.stRejected")]
        : q.status === "failed"
          ? [bad, "bg-error", t("upload.stFailed")]
          : q.status === "retrying"
            ? [warm, "bg-tertiary animate-pulse", t("upload.stRetrying", { attempt: q.attempt, max: MAX_ATTEMPTS })]
            : q.status === "uploading"
              ? q.slow
                ? [warm, "bg-tertiary animate-pulse", t("upload.stSlow", { pct })]
                : [calm, "bg-primary-container animate-pulse", t("upload.stUploading", { pct })]
              : [calm, "bg-primary-container animate-pulse", t("upload.ready")];
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${cls}`}>
      <span className={`w-2 h-2 rounded-full ${dot}`}></span>
      <span className="font-label-md text-label-md font-bold">{label}</span>
    </div>
  );
}
