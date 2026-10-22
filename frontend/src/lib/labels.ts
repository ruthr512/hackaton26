import type { BacklogState, DocType, FieldName, FieldValue, Role, User } from "./api";
import { hasKey, type Translate } from "@/i18n";

export const fieldLabel = (t: Translate, name: FieldName) => t(`field.${name}`);

/** Label for a review reason code; unknown codes are shown as-is. `rule:<id>` names the lab's rule. */
export function reasonLabel(t: Translate, code: string, ruleNames?: Record<string, string>, detail?: string): string {
  if (code.startsWith("rule:")) return t("reason.rule", { name: ruleNames?.[code] ?? code.slice(5) });
  const key = `reason.${code}`;
  return hasKey(key) ? t(key, detail ? { name: detail } : undefined) : code;
}

/** Why a file or form failed, in the UI language; falls back to the server's own text for unknown codes. */
export function errorText(t: Translate, code: string | null | undefined, fallback?: string | null): string {
  const key = `err.${code}`;
  if (code && hasKey(key)) return t(key);
  return fallback || t("err.processing_failed");
}

/** Label for a form-level review reason (multiple_commitments, poor_quality, ...). */
export function formReasonLabel(t: Translate, code: string): string {
  const key = `formReason.${code}`;
  return hasKey(key) ? t(key) : code;
}

/** Label for a file warning (pages_missing, file_repaired). */
export function warningLabel(t: Translate, code: string): string {
  const key = `warn.${code}`;
  return hasKey(key) ? t(key) : code;
}

export const docTypeLabel = (t: Translate, type: DocType) => t(`docType.${type}`);

const ISO_DATE =/^(\d{4})-(\d{2})-(\d{2})$/;

/** Value as shown and edited: lists joined with ", ", ISO dates as DD/MM/YYYY. */
export function displayValue(name: FieldName, value: FieldValue): string {
  if (value === null) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (name === "receipt_date") {
    const m = ISO_DATE.exec(value);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  }
  return value;
}

export const roleLabel = (t: Translate, role: Role) => t(`role.${role}`);

/** Every role the user holds (older servers send only `role`). */
export const rolesOf = (user: User | null | undefined): Role[] =>
  user ? (user.roles && user.roles.length ? user.roles : [user.role]) : [];

export const hasRole = (user: User | null | undefined, ...roles: Role[]) =>
  rolesOf(user).some((r) => roles.includes(r));
export const workflowLabel = (t: Translate, state: BacklogState) => t(`wf.${state}`);

/** The server sends naive UTC timestamps (no zone suffix). */
export const parseUtc = (iso: string) => new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + "Z");

/** "2 hours ago" in the UI language. */
export function timeAgo(iso: string | null, locale: string): string {
  if (!iso) return "";
  const seconds = (parseUtc(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  return rtf.format(0, "minute");
}
