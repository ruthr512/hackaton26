import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, type PatientFile, type PatientForm } from "@/lib/api";
import { useI18n } from "@/i18n";
import { displayValue } from "@/lib/labels";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorkflowChip } from "@/components/workflow";
import { formLink } from "@/pages/IntakeQueuePage";

function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`}>{name}</span>;
}

const list = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v ? String(v) : "—");

/** Everything filed under one ID number: commitments (newest first), referrals and other documents. */
export function PatientPage() {
  const pid = useParams().pid ?? "";
  const { t } = useI18n();
  const [file, setFile] = useState<PatientFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .patient(pid)
      .then(setFile)
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? t("patients.notFound") : (e as Error).message));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  async function decide(f: PatientForm, action: "confirm" | "reject") {
    try {
      await api.linkPatient(f.id, action);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error && !file)
    return (
      <div className="w-full px-margin py-space-lg">
        <div className="max-w-[1200px] mx-auto flex flex-col gap-space-md">
          <Link to="/patients" className="text-secondary font-label-md text-label-md">
            ← {t("patients.back")}
          </Link>
          <Card className="p-space-lg text-on-surface-variant">{error}</Card>
        </div>
      </div>
    );
  if (!file)
    return (
      <div className="flex items-center gap-2 p-6 text-outline">
        <Icon name="progress_activity" className="animate-spin" /> {t("common.loading")}
      </div>
    );

  return (
    <div className="w-full px-margin py-space-lg">
      <div className="max-w-[1200px] mx-auto flex flex-col gap-space-lg">
        <Link to="/patients" className="text-secondary font-label-md text-label-md flex items-center gap-1 w-fit">
          <Icon name="search" className="text-[18px]" /> {t("patients.back")}
        </Link>

        <Card className="p-space-lg flex flex-wrap items-center gap-space-lg">
          <div className="w-14 h-14 rounded-full bg-secondary/10 text-secondary flex items-center justify-center">
            <Icon name="person" className="text-[30px]" />
          </div>
          <div className="flex-1 min-w-[200px]">
            <h1 className="font-headline-lg text-headline-lg font-bold text-secondary" dir="auto">
              {file.names[0] ?? t("patients.unnamed")}
            </h1>
            <div className="flex items-center gap-2 font-data-mono-lg text-data-mono-lg text-on-surface" dir="ltr">
              {file.patient_id}
              <Icon name="verified" className="text-primary text-[18px]" />
            </div>
            {file.name_change && (
              <p className="font-body-sm text-body-sm text-tertiary font-bold flex items-start gap-1" dir="auto">
                <Icon name="warning" className="text-[16px] shrink-0 mt-0.5" />
                {t("patients.nameChanged", {
                  old: file.name_change.previous[file.name_change.previous.length - 1] ?? "",
                  new: file.name_change.current,
                })}
              </p>
            )}
            {file.names.length > 1 && (
              <p className="font-body-sm text-body-sm text-on-surface-variant" dir="auto">
                {t("patients.otherNames")}: {file.names.slice(1).join(" · ")}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone="neutral">{t("patients.commitments", { count: file.commitments.length })}</Badge>
            <Badge tone="neutral">{t("patients.documents", { count: file.documents.length })}</Badge>
            {file.pending_approval > 0 && (
              <Badge tone="processing">{t("patients.pendingApproval", { count: file.pending_approval })}</Badge>
            )}
          </div>
        </Card>

        {error && <div className="rounded-lg bg-error-container text-on-error-container px-4 py-2">{error}</div>}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-lg items-start">
          <Card className="lg:col-span-7">
            <CardHeader icon="timeline" title={t("patients.timeline")} />
            <div className="px-space-lg pb-space-lg flex flex-col gap-space-sm">
              {file.commitments.length === 0 && <p className="text-outline">{t("patients.noCommitments")}</p>}
              {file.commitments.map((c) => (
                <div key={c.id} className="flex gap-space-md items-start border-s-2 border-primary-container ps-space-md">
                  <img
                    src={api.imageUrl(c.id)}
                    alt=""
                    loading="lazy"
                    className="w-14 h-[72px] object-cover rounded-md bg-surface-container shrink-0"
                  />
                  <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-data-mono-sm text-data-mono-sm text-on-surface" dir="ltr">
                        {displayValue("receipt_date", (c.fields.receipt_date as string | null) ?? null) || "—"}
                      </span>
                      <span className="font-label-md text-label-md font-bold text-secondary">{list(c.fields.sender)}</span>
                      <WorkflowChip state={c.workflow} />
                      {c.patient_link === "manual" && <Badge tone="neutral">{t("patients.manualLink")}</Badge>}
                    </div>
                    <div className="font-body-sm text-body-sm text-on-surface-variant">
                      {t("field.commitment_numbers")}:{" "}
                      <span className="font-data-mono-sm text-data-mono-sm" dir="ltr">
                        {list(c.fields.commitment_numbers)}
                      </span>
                      {c.fields.test_type ? ` · ${t("field.test_type")}: ${list(c.fields.test_type)}` : ""}
                    </div>
                  </div>
                  <Link to={formLink(c)} className="text-primary font-label-md text-label-md font-bold shrink-0">
                    {t("patients.open")}
                  </Link>
                </div>
              ))}
            </div>
          </Card>

          <div className="lg:col-span-5 flex flex-col gap-space-lg">
            <Card>
              <CardHeader icon="description" title={t("patients.docsTitle")} />
              <div className="px-space-lg pb-space-lg flex flex-col gap-space-sm">
                {file.documents.length === 0 && <p className="text-outline">{t("patients.noDocs")}</p>}
                {file.documents.map((d) => (
                  <Link key={d.id} to={formLink(d)} className="flex gap-space-sm items-center rounded-xl p-2 hover:bg-surface-container-low">
                    <img
                      src={api.imageUrl(d.id)}
                      alt=""
                      loading="lazy"
                      className="w-12 h-16 object-cover rounded-md bg-surface-container shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="font-label-md text-label-md font-bold text-on-surface">
                        {t(`patients.kind.${d.doc_meta?.doc_kind ?? "other"}`)}
                      </div>
                      <div className="font-body-sm text-body-sm text-on-surface-variant">
                        <span dir="ltr">{displayValue("receipt_date", d.doc_meta?.doc_date ?? null) || "—"}</span>
                        {d.doc_meta?.test_type ? ` · ${d.doc_meta.test_type}` : ""}
                        {d.doc_meta?.referral_number ? ` · #${d.doc_meta.referral_number}` : ""}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </Card>

            {file.suggested.length > 0 && (
              <Card className="border-tertiary/30">
                <CardHeader icon="help" title={t("patients.suggestedTitle")} hint={t("patients.suggestedHint")} />
                <div className="px-space-lg pb-space-lg flex flex-col gap-space-sm">
                  {file.suggested.map((s) => (
                    <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-container-low p-2">
                      <Link to={formLink(s)} className="flex-1 min-w-0 font-body-sm text-body-sm">
                        <span dir="auto">{list(s.fields.full_name ?? s.doc_meta?.full_name)}</span> ·{" "}
                        <span className="font-data-mono-sm text-data-mono-sm" dir="ltr">
                          {list(s.fields.id_number ?? s.doc_meta?.id_number)}
                        </span>
                      </Link>
                      <Button size="sm" onClick={() => decide(s, "confirm")}>
                        {t("patients.confirm")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => decide(s, "reject")}>
                        {t("patients.reject")}
                      </Button>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </div>

        <p className="flex items-center gap-1 font-body-sm text-body-sm text-outline">
          <Icon name="policy" className="text-[16px]" /> {t("patients.auditNote")}
        </p>
      </div>
    </div>
  );
}
