import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import {
  api,
  type BacklogState,
  type DashAccuracy,
  type DashProblemFields,
  type DashTimeToApproval,
  type QueueForm,
  type Stage,
  type User,
  type WorkloadRow,
} from "@/lib/api";
import { fieldLabel, hasRole, roleLabel, timeAgo, workflowLabel } from "@/lib/labels";
import { useI18n } from "@/i18n";
import { usePolling } from "@/hooks/usePolling";
import { Card, CardHeader, Kpi } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { formLink } from "@/pages/IntakeQueuePage";

/* Chart colors. The four workflow stages keep one hue each across every chart (validated with the
   dataviz palette checker: lightness, chroma, CVD separation). Pink stays "needs a look". */
const STAGE_COLOR: Record<Stage, string> = {
  processing: "#2a78d6",
  needs_fix: "#1baf7a",
  pending_approval: "#6250d6",
  returned: "#e87ba4",
};
const STATE_COLOR: Record<BacklogState, string> = { ...STAGE_COLOR, approved: "#2B296D", failed: "#a3a2a8" };
const STAGES: Stage[] = ["processing", "needs_fix", "pending_approval", "returned"];
const LINE = "#1baf7a";
const GRID = "rgba(43,41,109,0.08)";
const AXIS = { fontSize: 12, fill: "#3c4a45" };
/* sequential blue ramp, light -> dark, for the problem-field heatmap */
const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];

function Empty() {
  const { t } = useI18n();
  return <div className="flex items-center justify-center h-full min-h-[200px] text-body-md text-outline">{t("dash.noData")}</div>;
}

function ChartTip({ active, payload, label, format }: TooltipProps<number, string> & { format: (v: number, name: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl bg-white/95 backdrop-blur px-3 py-2 shadow-[0_16px_40px_-8px_rgba(43,41,109,0.12)] text-body-sm">
      {label && <div className="font-bold text-navy mb-1">{label}</div>}
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: (p.payload?.fill as string) || p.color }} />
          <span className="text-on-surface-variant">{p.name}</span>
          <span className="font-data-mono-sm text-navy ms-auto" dir="ltr">
            {format(Number(p.value), String(p.dataKey))}
          </span>
        </div>
      ))}
    </div>
  );
}

function ChartCard({ title, hint, icon, children }: { title: string; hint: string; icon: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col">
      <CardHeader title={title} hint={hint} icon={icon} />
      <div className="px-space-md pb-space-md flex-1">{children}</div>
    </Card>
  );
}

const shortDay = (iso: string, locale: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString(locale, { day: "numeric", month: "numeric" });

export function DashboardPage() {
  const { t, locale } = useI18n();
  const refreshMs = 15000;
  const backlog = usePolling(api.dashBacklog, () => true, refreshMs);
  const accuracy = usePolling(api.dashAccuracy, () => true, refreshMs);
  const problems = usePolling(api.dashProblemFields, () => true, refreshMs);
  const time = usePolling(api.dashTimeToApproval, () => true, refreshMs);
  const workload = usePolling(api.dashWorkload, () => true, refreshMs);

  const states = backlog.data?.states ?? [];
  const count = (s: BacklogState) => states.find((x) => x.state === s)?.count ?? 0;
  const hours = (n: number | null | undefined) => (n == null ? "—" : t("dash.hours", { n: n.toFixed(1) }));
  const error = backlog.error && !backlog.data ? backlog.error : null;

  return (
    <div className="w-full px-margin py-space-lg">
      <div className="max-w-[1440px] mx-auto flex flex-col gap-space-lg">
        <div>
          <h1 className="font-headline-lg text-headline-lg font-bold text-navy">{t("dash.title")}</h1>
          <p className="font-body-md text-body-md text-on-surface-variant">{t("dash.subtitle")}</p>
        </div>
        {error && <div className="rounded-lg bg-error-container px-4 py-1.5 text-body-md text-on-error-container">{error}</div>}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-space-md" data-guide="dash-kpis">
          <Kpi
            label={t("dash.kpiAccuracy")}
            value={accuracy.data?.accuracy != null ? `${accuracy.data.accuracy}%` : "—"}
            icon="auto_awesome"
          />
          <Kpi label={t("dash.kpiPending")} value={count("pending_approval")} icon="fact_check" />
          <Kpi label={t("dash.kpiNeedsFix")} value={count("needs_fix") + count("returned")} icon="edit_note" accent={count("returned") > 0} />
          <Kpi label={t("dash.kpiTime")} value={hours(time.data?.avg_hours)} icon="schedule" />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-space-lg">
          <ChartCard title={t("dash.backlog")} hint={t("dash.backlogHint")} icon="stacked_bar_chart">
            <BacklogChart states={states} />
          </ChartCard>
          <ChartCard title={t("dash.accuracy")} hint={t("dash.accuracyHint")} icon="show_chart">
            <AccuracyChart data={accuracy.data} locale={locale} />
          </ChartCard>
          <ChartCard title={t("dash.problemFields")} hint={t("dash.problemHint")} icon="grid_on">
            <ProblemHeatmap data={problems.data} />
          </ChartCard>
          <ChartCard title={t("dash.time")} hint={t("dash.timeHint")} icon="timelapse">
            <TimeChart data={time.data} locale={locale} />
          </ChartCard>
        </div>

        <Reassign workload={workload.data ?? []} onChanged={workload.refresh} />
      </div>
    </div>
  );
}

function BacklogChart({ states }: { states: { state: BacklogState; count: number }[] }) {
  const { t } = useI18n();
  if (!states.some((s) => s.count > 0)) return <Empty />;
  const rows = states.map((s) => ({ ...s, label: workflowLabel(t, s.state), fill: STATE_COLOR[s.state] }));
  return (
    <div dir="ltr" className="h-[260px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 8, bottom: 4, left: 8 }} barCategoryGap={6}>
          <CartesianGrid horizontal={false} stroke={GRID} />
          <XAxis type="number" allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="label" orientation="right" width={110} tick={AXIS} axisLine={false} tickLine={false} />
          <Tooltip cursor={{ fill: "rgba(43,41,109,0.04)" }} content={<ChartTip format={(v) => String(v)} />} />
          <Bar dataKey="count" name={t("col.inQueue")} radius={[4, 4, 4, 4]} maxBarSize={22} label={{ position: "left", ...AXIS }}>
            {rows.map((r) => (
              <Cell key={r.state} fill={r.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function AccuracyChart({ data, locale }: { data: DashAccuracy | null; locale: string }) {
  const { t } = useI18n();
  if (!data || data.by_day.length === 0) return <Empty />;
  const rows = data.by_day.map((d) => ({ ...d, label: shortDay(d.day, locale) }));
  return (
    <div dir="ltr" className="h-[260px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis domain={[0, 100]} unit="%" tick={AXIS} axisLine={false} tickLine={false} width={44} />
          <Tooltip content={<ChartTip format={(v) => `${v}%`} />} />
          <Line
            type="monotone"
            dataKey="accuracy"
            name={t("dash.kpiAccuracy")}
            stroke={LINE}
            strokeWidth={2}
            dot={{ r: 4, fill: LINE, stroke: "#fff", strokeWidth: 2 }}
            activeDot={{ r: 6, stroke: "#fff", strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ProblemHeatmap({ data }: { data: DashProblemFields | null }) {
  const { t } = useI18n();
  if (!data || data.fields.every((f) => f.corrections === 0)) return <Empty />;
  const max = Math.max(1, ...data.fields.flatMap((f) => Object.values(data.cells[f.field] ?? {})));
  const shade = (n: number) => (n === 0 ? "#f2f3f6" : RAMP[Math.min(RAMP.length - 1, Math.ceil((n / max) * RAMP.length) - 1)]);
  const ink = (n: number) => (n > 0 && n / max > 0.5 ? "#ffffff" : "#191c1e");
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate" style={{ borderSpacing: 2 }}>
        <thead>
          <tr>
            <th />
            {data.senders.map((s) => (
              <th key={s} className="px-1 pb-1 font-label-sm text-label-sm text-on-surface-variant font-bold text-center" dir="auto">
                {s}
              </th>
            ))}
            <th className="px-1 pb-1 font-label-sm text-label-sm text-on-surface-variant text-center">Σ</th>
          </tr>
        </thead>
        <tbody>
          {data.fields.map((f) => (
            <tr key={f.field}>
              <th className="pe-2 font-label-md text-label-md text-navy text-start whitespace-nowrap">{fieldLabel(t, f.field)}</th>
              {data.senders.map((s) => {
                const n = data.cells[f.field]?.[s] ?? 0;
                return (
                  <td
                    key={s}
                    title={`${fieldLabel(t, f.field)} · ${s}: ${t("dash.corrections", { count: n })}`}
                    className="h-9 min-w-12 rounded-[4px] text-center font-data-mono-sm text-data-mono-sm"
                    style={{ background: shade(n), color: ink(n) }}
                  >
                    {n || ""}
                  </td>
                );
              })}
              <td className="text-center font-data-mono-sm text-data-mono-sm text-navy font-bold">{f.corrections}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TimeChart({ data, locale }: { data: DashTimeToApproval | null; locale: string }) {
  const { t } = useI18n();
  if (!data || data.by_day.length === 0) return <Empty />;
  const rows = data.by_day.map((d) => ({ ...d, label: shortDay(d.day, locale) }));
  const fmt = (v: number) => t("dash.hours", { n: v.toFixed(1) });
  return (
    <div className="flex flex-col gap-space-sm">
      {/* legend doubles as the data table: each stage with its overall average */}
      <ul className="flex flex-wrap gap-x-space-md gap-y-1">
        {data.stages.map((s) => (
          <li key={s.stage} className="flex items-center gap-1.5 font-body-sm text-body-sm text-on-surface-variant">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: STAGE_COLOR[s.stage] }} />
            {workflowLabel(t, s.stage)}
            <span className="font-data-mono-sm text-navy" dir="ltr">
              {fmt(s.avg_hours)}
            </span>
          </li>
        ))}
      </ul>
      <div dir="ltr" className="h-[230px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 4, right: 16, bottom: 4, left: 0 }} barCategoryGap="30%">
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} width={40} />
            <Tooltip cursor={{ fill: "rgba(43,41,109,0.04)" }} content={<ChartTip format={(v) => fmt(v)} />} />
            {STAGES.map((s, i) => (
              <Bar
                key={s}
                dataKey={s}
                name={workflowLabel(t, s)}
                stackId="t"
                fill={STAGE_COLOR[s]}
                stroke="#ffffff"
                strokeWidth={2}
                maxBarSize={36}
                radius={i === STAGES.length - 1 ? [4, 4, 0, 0] : 0}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Reassign({ workload, onChanged }: { workload: WorkloadRow[]; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const [forms, setForms] = useState<QueueForm[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const load = () => {
    api.intakeForms().then(setForms).catch(() => {});
  };
  useEffect(() => {
    load();
    api.users().then(setUsers).catch(() => {});
  }, []);

  const clerks = users.filter((u) => hasRole(u, "intake"));

  async function assign(formId: number, userId: number) {
    try {
      await api.assignForm(formId, userId);
      setMessage(t("dash.assigned"));
      load();
      onChanged();
    } catch (e) {
      setMessage((e as Error).message);
    }
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-space-lg items-start">
      <Card className="xl:col-span-5 overflow-hidden">
        <CardHeader title={t("dash.workload")} icon="groups" />
        <table className="w-full">
          <thead className="bg-surface-container-low text-navy font-label-md text-label-md">
            <tr>
              <th className="px-space-md py-2 text-start">{t("col.worker")}</th>
              <th className="px-space-md py-2 text-start">{t("col.role")}</th>
              <th className="px-space-md py-2 text-start">{t("col.inQueue")}</th>
              <th className="px-space-md py-2 text-start">{t("col.handledWeek")}</th>
            </tr>
          </thead>
          <tbody>
            {workload.map((w) => (
              <tr key={w.id} className="border-t border-[rgba(43,41,109,0.06)]">
                <td className="px-space-md py-2.5 font-label-md text-label-md text-navy font-bold">{w.display_name || w.username}</td>
                <td className="px-space-md py-2.5 font-body-md text-body-md text-on-surface-variant">{roleLabel(t, w.role)}</td>
                <td className="px-space-md py-2.5 font-data-mono-sm text-data-mono-sm" dir="ltr">
                  {w.in_queue ?? "—"}
                </td>
                <td className="px-space-md py-2.5 font-data-mono-sm text-data-mono-sm" dir="ltr">
                  {w.handled_week}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="xl:col-span-7 overflow-hidden" data-guide="dash-reassign">
        <CardHeader
          title={t("dash.reassign")}
          hint={t("dash.reassignHint")}
          icon="swap_horiz"
          action={message ? <span className="font-body-sm text-body-sm text-primary font-bold">{message}</span> : undefined}
        />
        {forms.length === 0 ? (
          <Empty />
        ) : (
          <div className="max-h-[360px] overflow-y-auto">
            <table className="w-full">
              {/* z-10 + opaque th background: positioned cells in the rows paint above a z-index:auto sticky header */}
              <thead className="text-navy font-label-md text-label-md sticky top-0 z-10">
                <tr>
                  <th className="px-space-md py-2 text-start bg-surface-container-low">{t("col.form")}</th>
                  <th className="px-space-md py-2 text-start bg-surface-container-low">{t("col.status")}</th>
                  <th className="px-space-md py-2 text-start bg-surface-container-low">{t("col.waiting")}</th>
                  <th className="px-space-md py-2 text-start bg-surface-container-low">{t("col.assignee")}</th>
                </tr>
              </thead>
              <tbody>
                {forms.map((f) => (
                  <tr key={f.id} className="border-t border-[rgba(43,41,109,0.06)]">
                    <td className="px-space-md py-2">
                      <Link to={formLink(f)} className="font-label-md text-label-md text-navy font-bold hover:underline truncate max-w-[200px] block" dir="auto">
                        {f.filename}
                      </Link>
                      <span className="font-body-sm text-body-sm text-on-surface-variant">{t("queue.page", { page: f.page_index + 1 })}</span>
                    </td>
                    <td className="px-space-md py-2 font-body-sm text-body-sm">{workflowLabel(t, f.workflow)}</td>
                    <td className="px-space-md py-2 font-data-mono-sm text-data-mono-sm text-on-surface-variant whitespace-nowrap">
                      {timeAgo(f.waiting_since, locale)}
                    </td>
                    <td className="px-space-md py-2">
                      <Select
                        ariaLabel={t("dash.reassign")}
                        icon="person"
                        value={f.assigned_to == null ? "" : String(f.assigned_to)}
                        placeholder={t("dash.unassigned")}
                        options={clerks.map((u) => ({ value: String(u.id), label: u.display_name || u.username }))}
                        onChange={(v) => assign(f.id, Number(v))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
