import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type FlaggedFilter, type MyQueue, type QueueForm } from "@/lib/api";
import { errorText, timeAgo } from "@/lib/labels";
import { useI18n, type MessageKey } from "@/i18n";
import { usePolling } from "@/hooks/usePolling";
import { cn } from "@/lib/utils";
import { Card, CardHeader, Kpi } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ReturnDialog, WorkflowChip } from "@/components/workflow";
import { formLink } from "@/pages/IntakeQueuePage";

type ApproverQueue = Extract<MyQueue, { role: "approver" }>;

const FILTERS: [FlaggedFilter, MessageKey][] = [
  ["all", "approvals.filterAll"],
  ["none", "approvals.filterNone"],
  ["some", "approvals.filterSome"],
  ["many", "approvals.filterMany"],
];

function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`}>{name}</span>;
}

export function ApprovalQueuePage() {
  const { t, locale } = useI18n();
  const [filter, setFilter] = useState<FlaggedFilter>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [returning, setReturning] = useState<QueueForm | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data, error, refresh } = usePolling(
    () => api.myQueue(filter, "approver") as Promise<ApproverQueue>,
    () => true,
    5000,
    [filter],
  );

  if (error && !data) return <div className="p-6 text-error">{error}</div>;
  if (!data)
    return (
      <div className="flex items-center gap-2 p-6 text-outline">
        <Icon name="progress_activity" className="animate-spin" /> {t("common.loading")}
      </div>
    );

  const ids = data.forms.map((f) => f.id);
  const chosen = ids.filter((id) => selected.has(id));
  const allChosen = ids.length > 0 && chosen.length === ids.length;

  async function act(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setActionError(errorText(t, (e as { code?: string | null }).code, (e as Error).message));
    }
  }

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="w-full px-margin py-space-lg">
      <div className="max-w-[1440px] mx-auto flex flex-col gap-space-lg">
        <div className="flex flex-wrap items-end justify-between gap-space-sm">
          <div>
            <div className="flex items-center gap-space-sm">
              <h1 className="font-headline-lg text-headline-lg font-bold text-navy">{t("approvals.title")}</h1>
              <Badge tone="neutral">{t("approvals.count", { count: data.today.waiting })}</Badge>
            </div>
            <p className="font-body-md text-body-md text-on-surface-variant">{t("approvals.subtitle")}</p>
          </div>
        </div>

        {actionError && (
          <div className="rounded-lg bg-error-container px-4 py-1.5 text-body-md text-on-error-container">{actionError}</div>
        )}

        <div className="flex flex-col gap-space-lg">
          <Card className="overflow-hidden" data-guide="approvals-table">
            <div
              className="flex flex-wrap items-center justify-between gap-space-sm px-space-lg pt-space-lg pb-space-sm"
              data-guide="approvals-bulk"
            >
              <div className="flex items-center gap-1 bg-surface-container-highest/70 p-1 rounded-xl">
                {FILTERS.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setFilter(key);
                      setSelected(new Set());
                    }}
                    className={cn(
                      "px-3 py-1.5 rounded-lg font-label-sm text-label-sm transition-all",
                      filter === key
                        ? "bg-surface-container-lowest text-on-surface font-bold shadow-sm"
                        : "text-on-surface-variant hover:text-on-surface",
                    )}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
              <Button
                disabled={chosen.length === 0}
                onClick={() =>
                  act(async () => {
                    await api.approveBulk(chosen);
                    setSelected(new Set());
                  })
                }
              >
                <Icon name="done_all" className="text-[18px]" />
                {t("approvals.bulk", { count: chosen.length })}
              </Button>
            </div>

            {data.forms.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-outline">
                <Icon name="task_alt" className="text-[40px] text-primary" />
                {t("approvals.empty")}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] table-fixed text-start">
                  <colgroup>
                    <col style={{ width: "4%" }} />
                    <col style={{ width: "18%" }} />
                    <col style={{ width: "14%" }} />
                    <col style={{ width: "11%" }} />
                    <col style={{ width: "12%" }} />
                    <col style={{ width: "10%" }} />
                    <col style={{ width: "10%" }} />
                    <col style={{ width: "9%" }} />
                    <col style={{ width: "12%" }} />
                  </colgroup>
                  <thead className="bg-surface-container-low text-navy font-label-md text-label-md">
                    <tr>
                      <th className="ps-space-lg pe-2 py-2 text-start align-middle">
                        <input
                          type="checkbox"
                          aria-label={t("approvals.selectAll")}
                          checked={allChosen}
                          onChange={() => setSelected(allChosen ? new Set() : new Set(ids))}
                          className="w-4 h-4 accent-[#2BB99B]"
                        />
                      </th>
                      <th className="px-space-sm py-2 text-start align-middle whitespace-nowrap">{t("col.form")}</th>
                      <th className="px-space-sm py-2 text-start align-middle whitespace-nowrap">{t("field.full_name")}</th>
                      <th className="px-space-sm py-2 text-start align-middle whitespace-nowrap">{t("field.id_number")}</th>
                      <th className="px-space-sm py-2 text-start align-middle whitespace-nowrap">{t("col.sender")}</th>
                      <th className="px-space-sm py-2 text-start align-middle whitespace-nowrap">{t("col.flagged")}</th>
                      <th className="px-space-sm py-2 text-start align-middle whitespace-nowrap">{t("col.submittedBy")}</th>
                      <th className="px-space-sm py-2 text-start align-middle whitespace-nowrap">{t("col.waiting")}</th>
                      <th className="px-space-sm py-2 text-start" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.forms.map((f, i) => (
                      <tr key={f.id} className="border-t border-[rgba(43,41,109,0.06)] hover:bg-primary-container/5">
                        <td className="ps-space-lg pe-2 py-3 text-start align-middle">
                          <input
                            type="checkbox"
                            aria-label={t("approvals.formRef", { id: f.id })}
                            checked={selected.has(f.id)}
                            onChange={() => toggle(f.id)}
                            className="w-4 h-4 accent-[#2BB99B]"
                          />
                        </td>
                        <td className="px-space-sm py-3 text-start align-middle">
                          <Link to={formLink(f)} className="font-label-md text-label-md text-navy font-bold hover:underline truncate block" title={f.filename}>
                            <bdi dir="auto">{f.filename}</bdi>
                          </Link>
                          <span className="font-body-sm text-body-sm text-on-surface-variant">{t("queue.page", { page: f.page_index + 1 })}</span>
                        </td>
                        <td className="px-space-sm py-3 text-start align-middle font-body-md text-body-md truncate">
                          <bdi dir="auto">{(f.full_name as string) || "—"}</bdi>
                        </td>
                        <td className="px-space-sm py-3 text-start align-middle font-data-mono-sm text-data-mono-sm truncate">
                          <bdi dir="ltr">{(f.id_number as string) || "—"}</bdi>
                        </td>
                        <td className="px-space-sm py-3 text-start align-middle font-body-md text-body-md truncate">
                          <bdi dir="auto">{(f.sender as string) || "—"}</bdi>
                        </td>
                        <td className="px-space-sm py-3 text-start align-middle">
                          {f.flagged > 0 ? (
                            <Badge tone="review">{t("unit.fields", { count: f.flagged })}</Badge>
                          ) : (
                            <Badge tone="success">{t("approvals.clean")}</Badge>
                          )}
                        </td>
                        <td className="px-space-sm py-3 text-start align-middle font-body-md text-body-md truncate">{f.changed_by ?? t("queue.auto")}</td>
                        <td className="px-space-sm py-3 text-start align-middle font-data-mono-sm text-data-mono-sm text-on-surface-variant whitespace-nowrap">
                          {timeAgo(f.waiting_since, locale)}
                        </td>
                        <td className="px-space-sm py-3 text-start align-middle">
                          <div className="flex flex-wrap items-center gap-1 justify-start" data-guide={i === 0 ? "approvals-actions" : undefined}>
                            <Button size="sm" variant="outline" onClick={() => act(() => api.approveForm(f.id))}>
                              {t("approvals.approve")}
                            </Button>
                            <Button size="sm" variant="ghost" className="text-tertiary" onClick={() => setReturning(f)}>
                              {t("approvals.return")}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-space-md items-start">
            <Kpi label={t("approvals.approvedToday")} value={data.today.approved} icon="verified" />
            <Kpi label={t("approvals.returnedToday")} value={data.today.returned} icon="undo" accent={data.today.returned > 0} />
            <Card data-guide="approvals-history">
              <CardHeader title={t("approvals.history")} icon="history" />
              <ul className="px-space-lg pb-space-lg flex flex-col gap-2">
                {data.history.length === 0 && <li className="text-body-md text-outline">{t("approvals.historyEmpty")}</li>}
                {data.history.map((h, i) => (
                  <li key={i} className="grid grid-cols-[3.5rem_1.5rem_6.5rem_1fr] items-center justify-items-start gap-2">
                    <span className="font-data-mono-sm text-data-mono-sm text-navy" dir="ltr">
                      #{h.form_id}
                    </span>
                    <span className="flex items-center justify-start">
                      {h.workflow === "approved" && h.batch_id !== null && (
                        <Link to={`/batches/${h.batch_id}/export`} title={t("export.download")} aria-label={t("export.download")}>
                          <Icon name="download" className="text-[18px] text-primary" />
                        </Link>
                      )}
                    </span>
                    <WorkflowChip state={h.workflow} />
                    <span className="font-body-sm text-body-sm text-on-surface-variant whitespace-nowrap">{timeAgo(h.at, locale)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      </div>

      <ReturnDialog
        open={returning !== null}
        onOpenChange={(open) => !open && setReturning(null)}
        subject={returning ? `${returning.filename} · ${t("queue.page", { page: returning.page_index + 1 })}` : undefined}
        onConfirm={(comment) => act(() => api.returnForm(returning!.id, comment))}
      />
    </div>
  );
}
