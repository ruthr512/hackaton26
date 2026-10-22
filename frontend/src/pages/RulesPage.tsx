import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type DryRun, type Rule, type RuleExplain, type RuleParse, type RuleSpec } from "@/lib/api";
import { useI18n } from "@/i18n";
import { fieldLabel } from "@/lib/labels";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { formLink } from "@/pages/IntakeQueuePage";
import { cn } from "@/lib/utils";

function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`}>{name}</span>;
}

const EXAMPLE = "אם הקופה מכבי והבדיקה PCR – חובה מספר הפניה";
const STATUS_TONE = { active: "success", draft: "neutral", disabled: "neutral" } as const;

/** The rule as the system understood it: condition chips, then the action. */
function Understood({ explain }: { explain: RuleExplain }) {
  const { t } = useI18n();
  if (!explain.parts) return null;
  const { conditions, joiner, action } = explain.parts;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {conditions.length === 0 && <span className="font-label-md text-label-md text-on-surface-variant">{t("rules.always")}</span>}
      {conditions.map((c, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span className="font-label-md text-label-md text-on-surface-variant">{joiner}</span>}
          <span className="px-3 py-1 rounded-full bg-secondary/10 text-secondary font-label-md text-label-md font-bold">{c}</span>
        </span>
      ))}
      <Icon name="arrow_back" className="text-on-surface-variant text-[18px] ltr:rotate-180" />
      <span className="px-3 py-1 rounded-full bg-tertiary/10 text-tertiary font-label-md text-label-md font-bold">{action}</span>
    </div>
  );
}

/** Rules written in plain Hebrew: convert, see what they would have flagged, then turn them on. */
export function RulesPage() {
  const { t } = useI18n();
  const [rules, setRules] = useState<Rule[]>([]);
  const [text, setText] = useState(EXAMPLE);
  const [parsed, setParsed] = useState<RuleParse | null>(null);
  const [dry, setDry] = useState<DryRun | null>(null);
  const [applyOpen, setApplyOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => api.rules().then(setRules).catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  async function convert() {
    setBusy(true);
    setError(null);
    setNotice(null);
    setParsed(null);
    setDry(null);
    try {
      const p = await api.parseRule(text);
      setParsed(p);
      if (p.spec) setDry(await api.dryRunRule(p.spec));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save(activate: boolean) {
    if (!parsed?.spec) return;
    setBusy(true);
    setError(null);
    try {
      const rule = await api.createRule({ name: parsed.name, source_text: text, spec: parsed.spec });
      if (activate) {
        const on = await api.activateRule(rule.id, applyOpen);
        setNotice(t("rules.activated", { count: on.flagged_open ?? 0 }));
      } else setNotice(t("rules.savedDraft"));
      setParsed(null);
      setDry(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(rule: Rule) {
    try {
      if (rule.status === "active") await api.disableRule(rule.id);
      else {
        const on = await api.activateRule(rule.id, applyOpen);
        setNotice(t("rules.activated", { count: on.flagged_open ?? 0 }));
      }
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function tryExisting(rule: Rule) {
    setText(rule.source_text);
    setParsed({ ...rule, unknown_terms: [], question: null, errors: [] } as RuleParse);
    try {
      setDry(await api.dryRunRule(rule.spec as RuleSpec));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const maxSender = dry ? Math.max(1, ...Object.values(dry.by_sender)) : 1;

  return (
    <div className="w-full px-margin py-space-lg">
      <div className="max-w-[1440px] mx-auto flex flex-col gap-space-lg">
        <div>
          <h1 className="font-headline-lg text-headline-lg font-bold text-on-surface">{t("rules.title")}</h1>
          <p className="font-body-md text-body-md text-on-surface-variant">{t("rules.subtitle")}</p>
        </div>

        {notice && (
          <div className="rounded-lg bg-primary-container/15 text-on-primary-container px-4 py-2">{notice}</div>
        )}
        {error && <div className="rounded-lg bg-error-container text-on-error-container px-4 py-2">{error}</div>}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-lg items-start">
          {/* Existing rules */}
          <Card className="lg:col-span-4 lg:order-1">
            <CardHeader icon="rule" title={t("rules.listTitle")} hint={t("rules.listHint")} />
            <div className="px-space-lg pb-space-lg flex flex-col gap-space-sm">
              {rules.length === 0 && <p className="text-outline font-body-sm text-body-sm">{t("rules.none")}</p>}
              {rules.map((r) => (
                <div key={r.id} className="rounded-xl bg-surface-container-low p-3 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <button type="button" className="font-label-md text-label-md font-bold text-start" onClick={() => tryExisting(r)}>
                      {r.name}
                    </button>
                    <Badge tone={STATUS_TONE[r.status]} className={cn(r.status === "draft" && "ring-1 ring-secondary/30")}>
                      {t(`rules.status.${r.status}`)}
                    </Badge>
                  </div>
                  <p className="font-body-sm text-body-sm text-on-surface-variant" dir="auto">
                    {r.description ?? r.source_text}
                  </p>
                  <div className="flex items-center justify-between gap-2">
                    {r.last_dry_run && (
                      <span className="font-data-mono-sm text-data-mono-sm text-on-surface-variant">
                        {t("rules.flaggedOf", { flagged: r.last_dry_run.flagged, checked: r.last_dry_run.checked })}
                      </span>
                    )}
                    <Button size="sm" variant={r.status === "active" ? "outline" : "default"} onClick={() => toggle(r)}>
                      {r.status === "active" ? t("rules.disable") : t("rules.activate")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <div className="lg:col-span-8 flex flex-col gap-space-lg">
            {/* Write */}
            <Card data-guide="rules-write">
              <CardHeader icon="edit_note" title={t("rules.writeTitle")} hint={t("rules.writeHint")} />
              <div className="px-space-lg pb-space-lg flex flex-col gap-space-sm">
                <Textarea value={text} onChange={(e) => setText(e.target.value)} dir="auto" className="text-body-lg" />
                <div className="flex justify-end">
                  <Button onClick={convert} disabled={busy || !text.trim()}>
                    <Icon name={busy ? "progress_activity" : "auto_awesome"} className={cn("text-[18px]", busy && "animate-spin")} />
                    {t("rules.convert")}
                  </Button>
                </div>
              </div>
            </Card>

            {/* Understood */}
            {parsed && (
              <Card>
                <CardHeader icon="psychology" title={t("rules.understoodTitle")} />
                <div className="px-space-lg pb-space-lg flex flex-col gap-space-sm">
                  {parsed.spec ? (
                    <>
                      <Understood explain={parsed} />
                      <button
                        type="button"
                        className="text-secondary font-label-sm text-label-sm flex items-center gap-1 w-fit"
                        onClick={() => setShowJson((v) => !v)}
                      >
                        <Icon name="data_object" className="text-[16px]" /> JSON
                      </button>
                      {showJson && (
                        <pre className="bg-surface-container-low rounded-lg p-3 font-data-mono-sm text-data-mono-sm overflow-x-auto" dir="ltr">
                          {JSON.stringify(parsed.spec, null, 2)}
                        </pre>
                      )}
                    </>
                  ) : (
                    <div className="flex items-start gap-2 rounded-lg bg-tertiary/5 text-tertiary p-3">
                      <Icon name="help" className="text-[20px] shrink-0" />
                      <div className="flex flex-col gap-1">
                        <strong>{parsed.question ?? t("rules.notUnderstood")}</strong>
                        {parsed.unknown_terms.length > 0 && (
                          <span className="font-body-sm text-body-sm">
                            {t("rules.unknownTerms")}: {parsed.unknown_terms.join(", ")}
                          </span>
                        )}
                        <span className="font-body-sm text-body-sm">{t("rules.rephrase")}</span>
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            )}

            {/* Dry run */}
            {dry && (
              <Card>
                <CardHeader icon="science" title={t("rules.dryTitle")} hint={t("rules.dryHint")} />
                <div className="px-space-lg pb-space-lg flex flex-col gap-space-md">
                  <div className="flex items-end gap-space-md">
                    <span className="font-data-mono-lg text-[56px] leading-none font-bold text-secondary" dir="ltr">
                      {dry.flagged}
                    </span>
                    <span className="font-headline-sm text-headline-sm text-on-surface pb-2">
                      {t("rules.wouldFlag", { count: dry.flagged, checked: dry.checked })}
                    </span>
                  </div>
                  {dry.warnings.map((w) => (
                    <div key={w.field} className="flex items-center gap-2 rounded-lg bg-tertiary/5 text-tertiary px-3 py-2 font-body-sm text-body-sm">
                      <Icon name="warning" className="text-[18px]" />
                      {t("rules.fieldNeverRead", { field: fieldLabel(t, w.field) })}
                    </div>
                  ))}
                  {Object.keys(dry.by_sender).length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <span className="font-label-md text-label-md font-bold">{t("rules.bySender")}</span>
                      {Object.entries(dry.by_sender).map(([sender, n]) => (
                        <div key={sender} className="flex items-center gap-2">
                          <span className="w-24 shrink-0 font-body-sm text-body-sm truncate">{sender}</span>
                          <div className="flex-1 h-2 rounded-full bg-surface-container overflow-hidden">
                            <div className="h-full bg-secondary rounded-full" style={{ width: `${(n / maxSender) * 100}%` }} />
                          </div>
                          <span className="font-data-mono-sm text-data-mono-sm w-8 text-end">{n}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {dry.examples.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead className="text-secondary font-label-md text-label-md">
                          <tr>
                            <th className="text-start py-2">{t("field.full_name")}</th>
                            <th className="text-start py-2">{t("field.id_number")}</th>
                            <th className="text-start py-2">{t("field.sender")}</th>
                            <th className="py-2"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {dry.examples.slice(0, 10).map((f) => (
                            <tr key={f.id} className="border-t border-surface-container">
                              <td className="py-2" dir="auto">{String(f.full_name ?? "—")}</td>
                              <td className="py-2 font-data-mono-sm text-data-mono-sm" dir="ltr">
                                {String(f.id_number ?? "—")}
                              </td>
                              <td className="py-2">{String(f.sender ?? "—")}</td>
                              <td className="py-2 text-end">
                                <Link to={formLink(f)} className="text-primary font-label-md text-label-md font-bold">
                                  {t("patients.open")}
                                </Link>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {parsed?.spec && !("id" in parsed) && (
                    <div className="flex flex-wrap items-center justify-between gap-space-sm border-t border-surface-container pt-space-md">
                      <label className="flex items-center gap-2 cursor-pointer font-body-md text-body-md">
                        <input
                          type="checkbox"
                          className="accent-primary w-4 h-4"
                          checked={applyOpen}
                          onChange={(e) => setApplyOpen(e.target.checked)}
                        />
                        {t("rules.applyOpen")}
                      </label>
                      <div className="flex gap-2">
                        <Button variant="outline" onClick={() => save(false)} disabled={busy}>
                          {t("rules.saveDraft")}
                        </Button>
                        <Button onClick={() => save(true)} disabled={busy}>
                          <Icon name="bolt" className="text-[18px]" /> {t("rules.activate")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
