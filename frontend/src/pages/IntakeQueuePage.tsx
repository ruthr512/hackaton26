import { Link } from "react-router-dom";
import { api, type MyQueue, type QueueForm } from "@/lib/api";
import { timeAgo } from "@/lib/labels";
import { useI18n, type MessageKey } from "@/i18n";
import { usePolling } from "@/hooks/usePolling";
import { Card, CardHeader, Kpi } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { WorkflowChip } from "@/components/workflow";

type IntakeQueue = Extract<MyQueue, { role: "intake" }>;

function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`}>{name}</span>;
}

/** Link to a form inside its batch's review screen. */
export const formLink = (f: Pick<QueueForm, "batch_id" | "id">) => `/batches/${f.batch_id}?form=${f.id}`;

export function IntakeQueuePage() {
  const { t, locale } = useI18n();
  const { data, error } = usePolling(() => api.myQueue(undefined, "intake") as Promise<IntakeQueue>, () => true, 5000);

  if (error && !data) return <div className="p-6 text-error">{error}</div>;
  if (!data)
    return (
      <div className="flex items-center gap-2 p-6 text-outline">
        <Icon name="progress_activity" className="animate-spin" /> {t("common.loading")}
      </div>
    );

  const kpis: [MessageKey, number, string, boolean?][] = [
    ["intake.received", data.today.received, "inbox"],
    ["intake.corrected", data.today.corrected, "edit_note"],
    ["intake.submitted", data.today.submitted, "send"],
    ["intake.waiting", data.today.waiting, "pending_actions", data.today.waiting > 0],
  ];

  return (
    <div className="w-full px-margin py-space-lg">
      <div className="max-w-[1440px] mx-auto flex flex-col gap-space-lg">
        <div className="flex flex-wrap items-end justify-between gap-space-sm">
          <div>
            <h1 className="font-headline-lg text-headline-lg font-bold text-navy">{t("intake.title")}</h1>
            <p className="font-body-md text-body-md text-on-surface-variant">{t("intake.subtitle")}</p>
          </div>
          <Link
            to="/"
            className="inline-flex items-center gap-2 h-10 px-5 rounded-[10px] bg-primary-container text-white font-bold shadow-md hover:bg-[#249f85]"
          >
            <Icon name="upload_file" className="text-[20px]" />
            {t("intake.upload")}
          </Link>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-space-md" data-guide="queue-kpis">
          {kpis.map(([key, value, icon, accent]) => (
            <Kpi key={key} label={t(key)} value={value} icon={icon} accent={accent} />
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-lg items-start">
          <Card className="lg:col-span-8 overflow-hidden" data-guide="queue-table">
            <CardHeader title={t("intake.queueTitle")} icon="assignment" />
            {data.forms.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-outline">
                <Icon name="task_alt" className="text-[40px] text-primary" />
                {t("intake.empty")}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-start">
                  <thead className="bg-surface-container-low text-navy font-label-md text-label-md">
                    <tr>
                      <th className="px-space-md py-2 text-start">{t("col.form")}</th>
                      <th className="px-space-md py-2 text-start">{t("col.sender")}</th>
                      <th className="px-space-md py-2 text-start">{t("col.flagged")}</th>
                      <th className="px-space-md py-2 text-start">{t("col.waiting")}</th>
                      <th className="px-space-md py-2 text-start">{t("col.status")}</th>
                      <th className="px-space-md py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.forms.map((f) => (
                      <QueueRow key={f.id} form={f} locale={locale} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="lg:col-span-4">
            <CardHeader title={t("intake.uploads")} icon="cloud_upload" />
            <div className="px-space-lg pb-space-lg flex flex-col gap-space-md">
              {data.uploads.length === 0 && <p className="text-body-md text-outline">{t("intake.uploadsEmpty")}</p>}
              {data.uploads.map((u) => {
                const state = u.status === "processing" ? "processing" : u.failed > 0 ? "failed" : "done";
                return (
                  <div key={u.id} className="flex flex-col gap-1.5">
                  <Link
                    to={u.status === "processing" ? `/batches/${u.id}/processing` : `/batches/${u.id}`}
                    className="flex flex-col gap-1.5 rounded-xl p-2 -m-2 hover:bg-surface-container-low"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-data-mono-sm text-data-mono-sm text-navy" dir="ltr">
                        #{u.id} · {timeAgo(u.created_at, locale)}
                      </span>
                      {state === "processing" ? (
                        <Badge tone="processing">{t("wf.processing")}</Badge>
                      ) : state === "failed" ? (
                        <Badge tone="review">{t("unit.formsFailed", { count: u.failed })}</Badge>
                      ) : (
                        <Badge tone="success">{t("intake.ready")}</Badge>
                      )}
                    </div>
                    <Progress value={u.forms ? u.done / u.forms : 0} failed={u.failed > 0} />
                    <span className="font-body-sm text-body-sm text-on-surface-variant">
                      {t("intake.uploadProgress", { done: u.done, forms: u.forms })}
                    </span>
                  </Link>
                  {u.approved > 0 && (
                    <Link
                      to={`/batches/${u.id}/export`}
                      className="inline-flex items-center gap-1 self-start font-label-sm text-label-sm font-bold text-primary hover:underline"
                    >
                      <span className="material-symbols-outlined text-[16px]">download</span>
                      {t("export.download")} ({u.approved})
                    </Link>
                  )}
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function QueueRow({ form: f, locale }: { form: QueueForm; locale: string }) {
  const { t } = useI18n();
  return (
    <>
      <tr className="border-t border-[rgba(43,41,109,0.06)] hover:bg-primary-container/5">
        <td className="px-space-md py-3">
          <div className="font-label-md text-label-md text-navy font-bold truncate max-w-[220px]" dir="auto" title={f.filename}>
            {f.filename}
          </div>
          <div className="font-body-sm text-body-sm text-on-surface-variant">{t("queue.page", { page: f.page_index + 1 })}</div>
        </td>
        <td className="px-space-md py-3 font-body-md text-body-md" dir="auto">
          {(f.sender as string) || "—"}
        </td>
        <td className="px-space-md py-3">
          {f.flagged > 0 ? <Badge tone="review">{t("unit.fields", { count: f.flagged })}</Badge> : <Badge tone="success">{t("approvals.clean")}</Badge>}
        </td>
        <td className="px-space-md py-3 font-data-mono-sm text-data-mono-sm text-on-surface-variant whitespace-nowrap">
          {timeAgo(f.waiting_since, locale)}
        </td>
        <td className="px-space-md py-3">
          <WorkflowChip state={f.workflow} />
        </td>
        <td className="px-space-md py-3 text-end">
          <Link
            to={formLink(f)}
            className="inline-flex items-center h-8 px-3 rounded-[10px] bg-white text-secondary ring-1 ring-outline-variant font-bold text-xs hover:bg-secondary/5"
          >
            {t("queue.open")}
          </Link>
        </td>
      </tr>
      {f.workflow === "returned" && f.approver_comment && (
        <tr>
          <td colSpan={6} className="px-space-md pb-3">
            <div className="border-s-4 border-tertiary bg-review/60 rounded-lg px-3 py-2 font-body-md text-body-md text-review-ink" dir="auto">
              <span className="font-bold">{t("intake.comment")}: </span>
              {f.approver_comment}
              {f.changed_by && <span className="text-on-surface-variant"> — {f.changed_by}</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
