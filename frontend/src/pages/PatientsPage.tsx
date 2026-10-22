import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type PatientSummary } from "@/lib/api";
import { useI18n } from "@/i18n";
import { timeAgo } from "@/lib/labels";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`}>{name}</span>;
}

/** Find a patient by ID, name (any script) or commitment number. */
export function PatientsPage() {
  const { t, locale } = useI18n();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PatientSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      api
        .searchPatients(q.trim())
        .then((r) => {
          setResults(r);
          setError(null);
        })
        .catch((e) => setError((e as Error).message));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [q]);

  return (
    <div className="w-full px-margin py-space-lg">
      <div className="max-w-[1100px] mx-auto flex flex-col gap-space-lg">
        <div>
          <h1 className="font-headline-lg text-headline-lg font-bold text-on-surface">{t("patients.title")}</h1>
          <p className="font-body-md text-body-md text-on-surface-variant">{t("patients.subtitle")}</p>
        </div>
        <div className="relative" data-guide="patients-search">
          <Icon name="search" className="absolute top-1/2 -translate-y-1/2 start-4 text-outline text-[22px]" />
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("patients.search")}
            className="h-14 ps-12 rounded-[20px] text-body-lg"
          />
        </div>
        {error && <div className="rounded-lg bg-error-container text-on-error-container px-4 py-2">{error}</div>}
        {results && results.length === 0 && (
          <Card className="p-space-lg text-center text-outline">{q ? t("patients.noResults") : t("patients.empty")}</Card>
        )}
        <div className="flex flex-col gap-space-sm">
          {results?.map((p) => (
            <Link key={p.patient_id} to={`/patients/${p.patient_id}`}>
              <Card className="p-space-md flex items-center gap-space-md hover:shadow-lg transition-shadow">
                <div className="w-11 h-11 rounded-full bg-secondary/10 text-secondary flex items-center justify-center shrink-0">
                  <Icon name="person" className="text-[24px]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-headline-sm text-headline-sm font-bold text-on-surface truncate" dir="auto">
                    {p.names[0] ?? t("patients.unnamed")}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 font-body-sm text-body-sm text-on-surface-variant">
                    <span className="font-data-mono-sm text-data-mono-sm" dir="ltr">
                      {p.patient_id}
                    </span>
                    {p.name_changed && <span className="text-tertiary font-bold">{t("patients.nameChangedBadge")}</span>}
                    {p.names.length > 1 && <span dir="auto">{p.names.slice(1).join(" · ")}</span>}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0 font-label-sm text-label-sm text-on-surface-variant">
                  <span>{t("patients.commitments", { count: p.commitments })}</span>
                  {p.documents > 0 && <span>{t("patients.documents", { count: p.documents })}</span>}
                  <span className="text-outline">{timeAgo(p.last_seen, locale)}</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
