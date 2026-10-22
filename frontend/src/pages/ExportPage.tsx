import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type ExportFormat, type ExportOptions, type ExportRow, type ExportSummary, type FieldName } from "@/lib/api";
import { useAuth } from "@/auth/AuthProvider";
import { displayValue, hasRole } from "@/lib/labels";
import { ConfirmDialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useI18n, type MessageKey, type Translate } from "@/i18n";

const CARD = "bg-surface-container-lowest rounded-[20px] shadow-[0_10px_30px_-5px_rgba(43,41,109,0.06)]";
const NAME_FIELDS = new Set<string>(["full_name"]);
const MONO_FIELDS = new Set<string>(["id_number", "central_numbers", "receipt_date", "commitment_numbers"]);

const DOWNLOAD_LABEL: Record<ExportFormat, MessageKey> = {
  xlsx: "export.downloadXlsx",
  csv: "export.downloadCsv",
  json: "export.downloadJson",
};

function formatDuration(t: Translate, seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return t("export.seconds", { value: seconds.toFixed(1) });
  const m = Math.floor(seconds / 60);
  return t("export.minutes", { value: `${m}:${String(Math.round(seconds % 60)).padStart(2, "0")}` });
}

function formatSize(bytes: number): string {
  const kb = bytes / 1024;
  return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
}

const pct = (c: number | null, digits = 1) => (c === null ? "" : `${(c * 100).toFixed(digits)}%`);

export function ExportPage() {
  const batchId = Number(useParams().id);
  const navigate = useNavigate();
  const { t } = useI18n();
  const { user } = useAuth();
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"main" | "confidence">("main");
  const [expanded, setExpanded] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmExport, setConfirmExport] = useState(false);

  useEffect(() => {
    api.exportSummary(batchId).then(setSummary).catch((e) => setError(e.message));
  }, [batchId]);

  if (error) return <div className="p-8 text-error">{error}</div>;
  if (!summary) return <div className="p-8 text-outline">{t("common.loading")}</div>;

  const { options, file } = summary;
  const isXlsx = options.format === "xlsx";
  const clean = summary.review === 0 && summary.failed_forms === 0 && !summary.processing;
  const extracted = summary.fields.ok + summary.fields.review;
  const suspicious = summary.fields.review + summary.fields.empty;
  const formatNames = summary.source_formats.join(" + ") || "—";

  async function setOptions(patch: Partial<ExportOptions>) {
    const next = { ...options, ...patch };
    setSummary((s) => (s ? { ...s, options: next } : s));
    try {
      const saved = await api.saveExportOptions(batchId, next);
      setSummary((s) => (s ? { ...s, options: saved.options, file: saved.file } : s));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function download() {
    if (isXlsx && options.password_protect && !password) {
      setPasswordError(true);
      return;
    }
    setDownloading(true);
    try {
      const blob = await api.downloadExport(batchId, password);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setSummary(await api.exportSummary(batchId));
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  const heroBadge = summary.processing
    ? { icon: "hourglass_top", text: t("export.badgeProcessing") }
    : clean
      ? { icon: "verified", text: t("export.badgeClean") }
      : { icon: "rule", text: t("export.badgeReview") };
  const heroTitle = summary.processing
    ? t("export.titleProcessing")
    : clean
      ? t("export.titleClean")
      : summary.review
        ? t("export.titleFields", { count: summary.review })
        : t("export.titleForms", { count: summary.failed_forms });

  return (
    <>
      {summary.unapproved > 0 && (
        <div className="w-full px-margin pt-space-sm">
          <div
            role="status"
            className="max-w-7xl mx-auto flex items-center gap-2 rounded-xl border-s-4 border-tertiary bg-review px-4 py-2 font-body-md text-body-md text-review-ink"
          >
            <span className="material-symbols-outlined text-[20px]">pending_actions</span>
            <span className="font-bold">
              {summary.approved === 0 ? t("export.noneApproved") : t("export.unapproved", { count: summary.unapproved })}
            </span>
          </div>
        </div>
      )}
      {/* Active Step Bar / Status Ribbon */}
      <section className="w-full bg-surface-container-low py-4 px-margin">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-primary-container text-on-primary font-bold text-xs">
              4
            </span>
            <span className="font-headline-sm text-headline-sm text-on-surface font-bold">
              {t("export.stepTitle")}
            </span>
          </div>
          <div className="flex items-center gap-2 text-on-surface-variant font-label-md text-label-md">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-primary-container animate-ping"></span>
            <span>{t("export.totalTime")}</span>
            <span className="font-data-mono-sm text-data-mono-sm font-semibold text-primary">
              {formatDuration(t, summary.processing_seconds)}
            </span>
            <span className="mx-2 opacity-30">|</span>
            <span>{t("export.scanNumber")}</span>
            <span className="font-data-mono-sm text-data-mono-sm text-secondary">#{summary.scan_number}</span>
          </div>
        </div>
      </section>

      {/* Main Content Layout */}
      <div className="w-full max-w-7xl mx-auto px-margin py-8 space-y-8">
        {/* 1. Success Hero Card */}
        <section className={cn("relative overflow-hidden p-8 md:p-10", CARD)}>
          <div className="absolute -top-12 -left-12 w-64 h-64 bg-primary-fixed/30 rounded-full blur-3xl pointer-events-none"></div>
          <div className="absolute -bottom-16 -right-16 w-72 h-72 bg-secondary-fixed/20 rounded-full blur-3xl pointer-events-none"></div>
          <div className="relative z-10 flex flex-col md:flex-row items-center gap-6 md:gap-8 text-center md:text-start">
            <div className="flex-shrink-0 relative">
              <div className={cn("w-20 h-20 rounded-full flex items-center justify-center", clean ? "bg-primary-container/20" : "bg-tertiary-container/25")}>
                <div
                  className={cn(
                    "w-14 h-14 rounded-full flex items-center justify-center text-on-primary shadow-lg",
                    clean ? "bg-primary-container shadow-primary/20" : "bg-tertiary shadow-tertiary/20",
                  )}
                >
                  <span className="material-symbols-outlined text-[34px]">
                    {summary.processing ? "hourglass_top" : clean ? "check" : "priority_high"}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex-1 space-y-2">
              <div
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-label-sm font-label-sm tracking-wider",
                  clean ? "bg-primary-fixed/60 text-on-primary-fixed" : "bg-tertiary-fixed text-on-tertiary-fixed-variant",
                )}
              >
                <span className="material-symbols-outlined text-[14px]">{heroBadge.icon}</span>
                <span>{heroBadge.text}</span>
              </div>
              <h1 className="font-headline-lg text-headline-lg text-secondary font-extrabold tracking-tight">{heroTitle}</h1>
              <p className="font-body-lg text-body-lg text-on-surface-variant max-w-3xl leading-relaxed">
                {clean ? (
                  t("export.cleanText")
                ) : (
                  <>
                    {summary.processing && `${t("export.processingNote")} `}
                    {summary.review > 0 && (
                      <>
                        {t("export.reviewNote", { count: summary.review })}{" "}
                        <Link to={`/batches/${batchId}`} className="font-bold text-primary underline">
                          {t("export.backToReview")}
                        </Link>
                        .{" "}
                      </>
                    )}
                    {summary.failed_forms > 0 && `${t("export.failedNote", { count: summary.failed_forms })} `}
                    {t("export.exportAnyway")}
                  </>
                )}
              </p>
            </div>
            {isXlsx && options.password_protect && (
              <div className="flex-shrink-0 flex flex-col items-center justify-center bg-surface-container-low px-5 py-4 rounded-xl">
                <span className="font-label-sm text-label-sm text-on-surface-variant mb-1">{t("export.securityProtocol")}</span>
                <span className="inline-flex items-center gap-1 font-data-mono-sm text-data-mono-sm font-semibold text-primary">
                  <span className="material-symbols-outlined text-[16px]">lock</span>
                  AES-256 Validated
                </span>
              </div>
            )}
          </div>
        </section>

        {/* 2. Bento Summary Stats */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className={cn("p-6 flex flex-col justify-between hover:shadow-md transition-shadow", CARD)}>
            <div className="flex items-center justify-between mb-4">
              <span className="font-label-md text-label-md text-on-surface-variant">{t("export.formsProcessed")}</span>
              <div className="w-10 h-10 rounded-xl bg-secondary-fixed/50 flex items-center justify-center text-secondary">
                <span className="material-symbols-outlined text-[20px]">description</span>
              </div>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-data-mono-lg text-4xl font-extrabold text-secondary">{summary.files}</span>
              <span className="font-body-md text-body-md text-on-surface-variant font-medium">
                {t("export.filesUnit")} {t("export.scannedPages", { count: summary.pages })}
              </span>
            </div>
            <div className="mt-4 pt-4 bg-surface-container-low/50 rounded-lg px-3 py-2 flex items-center justify-between text-label-sm font-label-sm text-on-surface-variant">
              <span>{t("export.sourceFormat", { formats: formatNames })}</span>
              <span className="text-primary font-semibold">{t("export.readable", { pct: summary.readable_pct })}</span>
            </div>
          </div>

          <div className={cn("p-6 flex flex-col justify-between hover:shadow-md transition-shadow", CARD)}>
            <div className="flex items-center justify-between mb-4">
              <span className="font-label-md text-label-md text-on-surface-variant">{t("export.fieldsExtracted")}</span>
              <div className="w-10 h-10 rounded-xl bg-primary-fixed/50 flex items-center justify-center text-primary">
                <span className="material-symbols-outlined text-[20px]">database</span>
              </div>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-data-mono-lg text-4xl font-extrabold text-primary-container">{extracted}</span>
              <span className="font-body-md text-body-md text-on-surface-variant font-medium">{t("export.verifiedFields")}</span>
            </div>
            <div className="mt-4 pt-4 bg-surface-container-low/50 rounded-lg px-3 py-2 flex items-center justify-between text-label-sm font-label-sm text-on-surface-variant">
              <span>
                {summary.failed_forms === 0 ? t("export.noStructural") : t("unit.formsFailed", { count: summary.failed_forms })}
              </span>
              <span className="text-primary font-semibold">{t("export.autoMapping")}</span>
            </div>
          </div>

          <div className={cn("p-6 flex flex-col justify-between hover:shadow-md transition-shadow", CARD)}>
            <div className="flex items-center justify-between mb-4">
              <span className="font-label-md text-label-md text-on-surface-variant">{t("export.avgAccuracy")}</span>
              <div className="w-10 h-10 rounded-xl bg-primary-fixed/50 flex items-center justify-center text-primary">
                <span className="material-symbols-outlined text-[20px]">analytics</span>
              </div>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-data-mono-lg text-4xl font-extrabold text-secondary">
                {summary.avg_confidence === null ? "—" : pct(summary.avg_confidence)}
              </span>
              <span className={cn("font-body-md text-body-md font-medium", summary.review === 0 ? "text-primary" : "text-tertiary")}>
                {summary.review === 0 ? t("export.checkOk") : t("export.fieldsPending", { count: summary.review })}
              </span>
            </div>
            <div className="mt-4 pt-4 bg-surface-container-low/50 rounded-lg px-3 py-2 flex items-center justify-between text-label-sm font-label-sm text-on-surface-variant">
              <span>{t("export.suspicious", { count: suspicious })}</span>
              <span className={cn("font-semibold", clean ? "text-primary" : "text-tertiary")}>
                {clean ? t("export.ready") : t("export.attention")}
              </span>
            </div>
          </div>
        </section>

        {/* 3. Live Interactive Excel Preview */}
        <section
          className={cn(
            "overflow-hidden",
            CARD,
            expanded && "fixed inset-0 z-[60] rounded-none flex flex-col overflow-y-auto",
          )}
        >
          <div className="bg-secondary text-on-secondary px-6 py-4 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center">
                <span className="material-symbols-outlined text-primary-fixed text-[20px]">table_chart</span>
              </div>
              <div>
                <h2 className="font-headline-sm text-headline-sm font-bold text-on-secondary">
                  {t("export.previewTitle")}
                </h2>
                <p className="font-body-sm text-body-sm text-secondary-fixed-dim">
                  {t("export.previewHint")}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-3 py-1 rounded-full bg-white/15 text-on-secondary text-data-mono-sm font-data-mono-sm">
                {t("export.records", { shown: summary.preview.length, total: summary.forms })}
              </span>
              <button
                className="px-3 py-1.5 rounded-lg bg-primary-container text-on-primary font-label-md text-label-md font-bold flex items-center gap-1.5 hover:opacity-90 transition-opacity"
                type="button"
                onClick={() => setExpanded((v) => !v)}
              >
                <span className="material-symbols-outlined text-[16px]">{expanded ? "fullscreen_exit" : "fullscreen"}</span>
                {expanded ? t("common.close") : t("export.expand")}
              </button>
            </div>
          </div>

          <div className={cn("overflow-x-auto w-full bg-surface-container-lowest", expanded && "flex-1")}>
            {tab === "main" ? (
              <table className="w-full text-start border-collapse min-w-[900px]">
                <thead>
                  <tr className="bg-surface-container font-headline-sm text-label-md text-on-surface select-none">
                    <th className="py-3 px-4 font-semibold w-16 text-start align-middle whitespace-nowrap">#</th>
                    {summary.columns.map((c) => (
                      <th key={c.field} className="py-3 px-4 font-semibold text-start align-middle whitespace-nowrap">
                        {c.header}
                      </th>
                    ))}
                    <th className="py-3 px-4 font-semibold text-start align-middle whitespace-nowrap">{t("export.statusCol")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-container font-body-md text-body-md text-on-surface">
                  {summary.preview.map((row, i) => (
                    <tr key={row._form_id} className="hover:bg-primary-fixed/10 transition-colors">
                      <td className="py-3.5 px-4 text-start align-middle font-data-mono-sm text-data-mono-sm text-on-surface-variant bg-surface-container-low/40">
                        {i + 1}
                      </td>
                      {summary.columns.map((c) => (
                        <Cell key={c.field} field={c.field} row={row} />
                      ))}
                      <td className="py-3.5 px-4 text-start align-middle">
                        <StatusBadge row={row} />
                      </td>
                    </tr>
                  ))}
                  {summary.preview.length === 0 && (
                    <tr>
                      <td colSpan={summary.columns.length + 2} className="p-8 text-center text-outline">
                        {t("export.noForms")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            ) : (
              <table className="w-full text-start border-collapse min-w-[900px]">
                <thead>
                  <tr className="bg-surface-container font-headline-sm text-label-md text-on-surface select-none">
                    <th className="py-3 px-4 font-semibold w-16 text-start align-middle whitespace-nowrap">#</th>
                    <th className="py-3 px-4 font-semibold text-start align-middle whitespace-nowrap">{t("export.fileCol")}</th>
                    <th className="py-3 px-4 font-semibold text-start align-middle whitespace-nowrap">{t("export.pageCol")}</th>
                    {summary.columns.map((c) => (
                      <th key={c.field} className="py-3 px-4 font-semibold text-start align-middle whitespace-nowrap">
                        {c.header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-container font-body-md text-body-md text-on-surface">
                  {summary.confidence_preview.map((r, i) => (
                    <tr key={i} className="hover:bg-primary-fixed/10 transition-colors">
                      <td className="py-3.5 px-4 text-start align-middle font-data-mono-sm text-data-mono-sm text-on-surface-variant bg-surface-container-low/40">
                        {i + 1}
                      </td>
                      <td className="py-3.5 px-4 text-start align-middle font-bold text-secondary"><bdi dir="auto">{r.filename}</bdi></td>
                      <td className="py-3.5 px-4 text-start align-middle font-data-mono-sm text-data-mono-sm">{r.page}</td>
                      {summary.columns.map((c) => {
                        const f = r.fields[c.field];
                        return (
                          <td key={c.field} className="py-3.5 px-4 text-start align-middle font-data-mono-sm text-data-mono-sm">
                            {!f || f.level === "empty" ? (
                              <span className="text-outline-variant">—</span>
                            ) : (
                              <span className={cn("font-bold", f.level === "review" ? "text-tertiary" : "text-primary")}>
                                {pct(f.confidence, 0)}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Excel Sheet Tabs at Bottom */}
          <div className="bg-surface-container-low px-4 py-2 flex items-center justify-between border-t-0 select-none">
            <div className="flex items-center gap-2 overflow-x-auto">
              <SheetTab active={tab === "main"} onClick={() => setTab("main")} emoji="📋" label={summary.sheet_name} />
              <SheetTab
                active={tab === "confidence"}
                onClick={() => setTab("confidence")}
                emoji="📊"
                label={isXlsx && options.include_details ? t("export.confidenceSheet") : t("export.confidenceExcluded")}
              />
            </div>
            <div className="hidden sm:flex items-center gap-1 text-on-surface-variant text-label-sm font-label-sm">
              <span className="material-symbols-outlined text-[16px]">grid_view</span>
              <span>Microsoft Excel Spreadsheet Format</span>
            </div>
          </div>
        </section>

        {/* 4. Export Options & File Configuration */}
        <section className={cn("p-6 md:p-8 space-y-6", CARD)}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-primary-fixed/50 flex items-center justify-center text-primary">
              <span className="material-symbols-outlined text-[22px]">tune</span>
            </div>
            <div>
              <h3 className="font-headline-md text-headline-md text-secondary font-bold">{t("export.optionsTitle")}</h3>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                {t("export.optionsHint")}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 pt-2">
            {/* Radio Selector: Format */}
            <div className="space-y-3">
              <span className="font-label-md text-label-md text-secondary font-bold block">{t("export.formatLabel")}</span>
              <FormatOption
                value="xlsx"
                current={options.format}
                onSelect={setOptions}
                title=".XLSX (Microsoft Excel 2016-365)"
                hint={t("export.xlsxHint")}
                aside={
                  <span className="px-2.5 py-1 rounded-full bg-primary-container text-on-primary text-label-sm font-label-sm font-bold">
                    {t("export.default")}
                  </span>
                }
              />
              <FormatOption
                value="csv"
                current={options.format}
                onSelect={setOptions}
                title={t("export.csvTitle")}
                hint={t("export.csvHint")}
                aside={<span className="text-label-sm font-label-sm text-on-surface-variant">{t("export.flat")}</span>}
              />
              <FormatOption
                value="json"
                current={options.format}
                onSelect={setOptions}
                title={t("export.jsonTitle")}
                hint={t("export.jsonHint")}
                aside={
                  <span className="px-2 py-0.5 rounded bg-surface-container-high text-on-surface-variant text-label-sm font-label-sm">
                    JSON
                  </span>
                }
              />
            </div>

            {/* Checkbox Options */}
            <div className="space-y-3">
              <span className="font-label-md text-label-md text-secondary font-bold block">{t("export.extrasLabel")}</span>
              <CheckOption
                checked={isXlsx && options.include_details}
                disabled={!isXlsx}
                onChange={(v) => setOptions({ include_details: v })}
                title={t("export.detailsTitle")}
                hint={t("export.detailsHint")}
              />
              <CheckOption
                checked={isXlsx && options.include_source_links}
                disabled={!isXlsx}
                onChange={(v) => setOptions({ include_source_links: v })}
                title={t("export.linksTitle")}
                hint={t("export.linksHint")}
              />
              <CheckOption
                checked={isXlsx && options.password_protect}
                disabled={!isXlsx}
                onChange={(v) => {
                  setPasswordError(false);
                  setOptions({ password_protect: v });
                }}
                title={t("export.passwordTitle")}
                hint={t("export.passwordHint")}
              >
                {isXlsx && options.password_protect && (
                  <div className="mt-3 space-y-1">
                    <input
                      type="password"
                      value={password}
                      autoComplete="new-password"
                      placeholder={t("export.passwordPlaceholder")}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setPasswordError(false);
                      }}
                      className={cn(
                        "w-full rounded-lg bg-surface-container-lowest px-3 py-2 font-body-md text-body-md outline-none ring-1 focus:ring-2 focus:ring-primary-container",
                        passwordError ? "ring-error" : "ring-outline-variant",
                      )}
                    />
                    <span className={cn("block font-body-sm text-body-sm", passwordError ? "text-error" : "text-on-surface-variant")}>
                      {passwordError ? t("export.passwordRequired") : t("export.passwordNote")}
                    </span>
                  </div>
                )}
              </CheckOption>
            </div>
          </div>
        </section>

        {/* 5. Bottom Download & Integration CTAs */}
        <section className={cn("p-6 md:p-8 flex flex-col xl:flex-row items-center justify-between gap-6", CARD)}>
          <div className="flex items-center gap-4 w-full xl:w-auto">
            <div className="w-14 h-14 rounded-2xl bg-[#107c41]/10 flex items-center justify-center text-[#107c41] flex-shrink-0">
              <span className="material-symbols-outlined text-[32px]">download_for_offline</span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-on-surface text-headline-sm font-headline-sm whitespace-nowrap">{file.filename}</span>
                <span className="px-2 py-0.5 rounded bg-surface-container-high text-on-surface-variant font-data-mono-sm text-data-mono-sm whitespace-nowrap">
                  {formatSize(file.size_bytes)}
                </span>
              </div>
              <span className="font-body-sm text-body-sm text-on-surface-variant">
                {isXlsx
                  ? t("export.includesXlsx", { sheets: file.sheets, fields: file.fields })
                  : t("export.includesFlat", { rows: file.rows, fields: file.fields })}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4 w-full xl:w-auto justify-end">
            {hasRole(user, "intake", "lab_manager") && (
              <button
                className="w-full sm:w-auto px-5 py-3.5 rounded-xl bg-surface-container text-secondary hover:bg-surface-variant transition-colors font-headline-sm text-headline-sm font-bold flex items-center justify-center gap-2"
                type="button"
                onClick={() => navigate("/")}
              >
                <span className="material-symbols-outlined text-[20px]">restart_alt</span>
                <span>{t("export.newScan")}</span>
              </button>
            )}
            <button
              className="w-full sm:w-auto px-6 py-3.5 rounded-xl bg-tertiary text-on-tertiary hover:opacity-95 shadow-md shadow-tertiary/20 transition-all font-headline-sm text-headline-sm font-bold flex items-center justify-center gap-2"
              type="button"
              onClick={() => setNotice(t("export.sendNotice"))}
            >
              <span className="material-symbols-outlined text-[20px]">send_time_extension</span>
              <span>{t("export.sendDirect")}</span>
            </button>
            <button
              className="w-full sm:w-auto px-8 py-4 rounded-xl bg-primary-container text-on-primary hover:bg-primary shadow-lg shadow-primary-container/30 transition-all font-headline-sm text-headline-sm font-extrabold flex items-center justify-center gap-3 disabled:opacity-50 disabled:pointer-events-none"
              type="button"
              disabled={summary.forms === 0 || downloading}
              onClick={() => (summary.review > 0 ? setConfirmExport(true) : download())}
            >
              <span className="material-symbols-outlined text-[24px]">download</span>
              <span>{t(DOWNLOAD_LABEL[options.format])}</span>
            </button>
          </div>
        </section>

        {notice && (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-secondary-fixed/60 px-4 py-3 text-on-secondary-fixed font-body-md text-body-md">
            <span className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px]">info</span>
              {notice}
            </span>
            <button
              type="button"
              className="material-symbols-outlined text-[18px]"
              aria-label={t("common.close")}
              onClick={() => setNotice(null)}
            >
              close
            </button>
          </div>
        )}

        {/* Contextual Guidance / Audit Note */}
        <div className="flex items-center justify-between text-on-surface-variant font-body-sm text-body-sm px-2 pb-4">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[18px]">verified</span>
            <span>{t("export.auditNote")}</span>
          </div>
          <span className="font-data-mono-sm text-data-mono-sm">
            SHA-256 Checksum: {file.sha256 ? `${file.sha256.slice(0, 13)}...` : t("export.checksumOnDownload")}
          </span>
        </div>
      </div>

      <ConfirmDialog
        open={confirmExport}
        onOpenChange={setConfirmExport}
        title={t("export.confirmTitle")}
        description={t("export.confirmDesc", { count: summary.review })}
        confirmLabel={t("export.confirmLabel")}
        onConfirm={download}
      />
    </>
  );
}

function Cell({ field, row }: { field: FieldName; row: ExportRow }) {
  const text = displayValue(field, (row[field] ?? null) as never);
  return (
    <td
      className={cn(
        "py-3.5 px-4 text-start align-middle",
        NAME_FIELDS.has(field) ? "font-bold text-secondary" : MONO_FIELDS.has(field) && "font-data-mono-sm text-data-mono-sm",
      )}
    >
      {!text ? (
        <span className="text-outline-variant">—</span>
      ) : field === "sender" ? (
        <span className="px-2.5 py-0.5 rounded-full bg-surface-container-high text-on-surface text-label-sm font-label-sm">{text}</span>
      ) : (
        text
      )}
    </td>
  );
}

function StatusBadge({ row }: { row: ExportRow }) {
  const { t } = useI18n();
  if (row._review > 0) {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-tertiary-fixed text-on-tertiary-fixed-variant font-label-sm text-label-sm font-bold">
        <span className="material-symbols-outlined text-[14px]">error</span>
        {t("export.rowReview", { count: row._review })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary-fixed/50 text-on-primary-fixed font-label-sm text-label-sm font-bold">
      <span className="material-symbols-outlined text-[14px]">check_circle</span>
      {t("export.rowVerified", { pct: pct(row._confidence) })}
    </span>
  );
}

function SheetTab({ active, onClick, emoji, label }: { active: boolean; onClick: () => void; emoji: string; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-4 py-2 font-label-md text-label-md rounded-t-lg flex items-center gap-2 whitespace-nowrap transition-colors",
        active
          ? "bg-surface-container-lowest text-primary font-bold shadow-sm"
          : "text-on-surface-variant hover:bg-surface-container hover:text-on-surface",
      )}
    >
      <span>{emoji}</span>
      <span>{label}</span>
      {active && <span className="w-2 h-2 rounded-full bg-primary-container"></span>}
    </button>
  );
}

function FormatOption(props: {
  value: ExportFormat;
  current: ExportFormat;
  onSelect: (patch: Partial<ExportOptions>) => void;
  title: string;
  hint: string;
  aside: React.ReactNode;
}) {
  const selected = props.value === props.current;
  return (
    <label
      className={cn(
        "flex items-center justify-between p-4 rounded-xl cursor-pointer transition-colors",
        selected ? "bg-primary-fixed/15 hover:bg-primary-fixed/25" : "bg-surface-container-low hover:bg-surface-container",
      )}
    >
      <div className="flex items-center gap-3">
        <input
          checked={selected}
          className="w-4 h-4 text-primary accent-primary cursor-pointer"
          name="export-format"
          type="radio"
          value={props.value}
          onChange={() => props.onSelect({ format: props.value })}
        />
        <div>
          <span className="font-bold text-on-surface block text-body-lg font-body-lg">{props.title}</span>
          <span className="font-body-sm text-body-sm text-on-surface-variant">{props.hint}</span>
        </div>
      </div>
      {props.aside}
    </label>
  );
}

function CheckOption(props: {
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
  title: string;
  hint: string;
  children?: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-3 p-4 rounded-xl bg-surface-container-low cursor-pointer hover:bg-surface-container transition-colors",
        props.disabled && "opacity-40 pointer-events-none",
      )}
    >
      <input
        checked={props.checked}
        disabled={props.disabled}
        className="mt-1 w-4 h-4 rounded text-primary accent-primary cursor-pointer"
        type="checkbox"
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <div className="space-y-0.5 flex-1">
        <span className="font-bold text-on-surface block text-body-md font-body-md">{props.title}</span>
        <span className="font-body-sm text-body-sm text-on-surface-variant">{props.hint}</span>
        {props.children}
      </div>
    </label>
  );
}
