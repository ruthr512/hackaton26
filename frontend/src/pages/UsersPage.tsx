import { useEffect, useState, type FormEvent } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { api, ApiError, type Role, type RolesInfo, type User } from "@/lib/api";
import { hasKey, useI18n } from "@/i18n";
import { rolesOf, roleLabel, timeAgo } from "@/lib/labels";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const ROLE_ORDER: Role[] = ["intake", "approver", "lab_manager", "admin"];
type ActiveFilter = "all" | "active" | "inactive";

function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`}>{name}</span>;
}

/** Draft of the user being created or edited in the drawer. */
interface Draft {
  id: number | null;
  username: string;
  display_name: string;
  roles: Role[];
  active: boolean;
  password: string;
}

const initials = (name: string) =>
  name
    .replace(/["״׳']/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("");

const emptyDraft: Draft = { id: null, username: "", display_name: "", roles: ["intake"], active: true, password: "" };

/** User management for the system admin: list, create, edit roles, reset password, deactivate. */
export function UsersPage() {
  const { t, locale, dir } = useI18n();
  const [users, setUsers] = useState<User[] | null>(null);
  const [rolesInfo, setRolesInfo] = useState<RolesInfo | null>(null);
  const [q, setQ] = useState("");
  const [role, setRole] = useState<Role | null>(null);
  const [active, setActive] = useState<ActiveFilter>("active");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmOff, setConfirmOff] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showMatrix, setShowMatrix] = useState(false);
  const [focusReset, setFocusReset] = useState(false);

  const load = () =>
    api
      .adminUsers({ q: q.trim() || undefined, role: role ?? undefined, active: active === "all" ? undefined : active === "active" })
      .then(setUsers)
      .catch((e) => setError((e as Error).message));

  useEffect(() => {
    const timer = window.setTimeout(load, 200);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, role, active]);

  useEffect(() => {
    api.adminRoles().then(setRolesInfo).catch(() => {});
  }, []);

  /** A server error code in the UI language (last_admin, username_taken, ...). */
  function explain(e: unknown): string {
    if (e instanceof ApiError && e.code) {
      const key = `users.err.${e.code}`;
      if (hasKey(key)) return t(key);
    }
    return (e as Error).message;
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setError(null);
    try {
      if (draft.id === null) {
        await api.createUser({
          username: draft.username,
          display_name: draft.display_name,
          roles: draft.roles,
          password: draft.password,
        });
        setNotice(t("users.created"));
      } else {
        await api.updateUser(draft.id, {
          username: draft.username,
          display_name: draft.display_name,
          roles: draft.roles,
          active: draft.active,
        });
        setNotice(t("users.saved"));
      }
      setDraft(null);
      load();
    } catch (err) {
      setError(explain(err));
    }
  }

  async function resetPassword() {
    if (!draft?.id || !newPassword) return;
    setError(null);
    try {
      await api.resetPassword(draft.id, newPassword);
      setNewPassword("");
      setNotice(t("users.passwordReset"));
    } catch (err) {
      setError(explain(err));
    }
  }

  async function deactivate(u: User) {
    setError(null);
    try {
      await api.deactivateUser(u.id);
      setNotice(t("users.deactivated", { name: u.display_name || u.username }));
      load();
    } catch (err) {
      setError(explain(err));
    }
  }

  async function reactivate(u: User) {
    try {
      await api.updateUser(u.id, { active: true });
      load();
    } catch (err) {
      setError(explain(err));
    }
  }

  const openEdit = (u: User, reset = false) => {
    setFocusReset(reset);
    setNewPassword("");
    setDraft({
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      roles: rolesOf(u),
      active: !!u.active,
      password: "",
    });
  };

  const toggleRole = (r: Role) =>
    setDraft((d) => (d ? { ...d, roles: d.roles.includes(r) ? d.roles.filter((x) => x !== r) : [...d.roles, r] } : d));

  const chip = (on: boolean) =>
    cn(
      "px-3 py-1.5 rounded-full font-label-md text-label-md transition-all",
      on ? "bg-secondary text-on-secondary font-bold shadow-sm" : "bg-surface-container text-on-surface-variant hover:bg-surface-container-high",
    );

  return (
    <div className="w-full px-margin py-space-lg">
      <div className="max-w-[1440px] mx-auto flex flex-col gap-space-lg">
        <div className="flex flex-wrap items-center justify-between gap-space-md">
          <div>
            <h1 className="font-headline-lg text-headline-lg font-bold text-on-surface">{t("users.title")}</h1>
            <p className="font-body-md text-body-md text-on-surface-variant">{t("users.subtitle")}</p>
          </div>
          <Button onClick={() => setDraft({ ...emptyDraft })} data-guide="users-new">
            <Icon name="person_add" className="text-[20px]" /> {t("users.new")}
          </Button>
        </div>

        {notice && (
          <div className="rounded-lg bg-primary-container/15 text-on-primary-container px-4 py-2 font-body-md text-body-md flex items-center justify-between">
            {notice}
            <button type="button" onClick={() => setNotice(null)} aria-label={t("common.close")}>
              <Icon name="close" className="text-[18px]" />
            </button>
          </div>
        )}
        {error && !draft && <div className="rounded-lg bg-error-container text-on-error-container px-4 py-2">{error}</div>}

        <Card className="p-space-md flex flex-wrap items-center gap-space-sm">
          <div className="relative flex-1 min-w-[220px]">
            <Icon name="search" className="absolute top-1/2 -translate-y-1/2 start-3 text-outline text-[20px]" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("users.search")} className="ps-10" />
          </div>
          <div className="flex flex-wrap gap-1">
            <button type="button" className={chip(role === null)} onClick={() => setRole(null)}>
              {t("users.allRoles")}
            </button>
            {ROLE_ORDER.map((r) => (
              <button key={r} type="button" className={chip(role === r)} onClick={() => setRole(r)}>
                {roleLabel(t, r)}
              </button>
            ))}
          </div>
          <div className="flex gap-1 bg-surface-container rounded-xl p-1">
            {(["active", "inactive", "all"] as ActiveFilter[]).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setActive(a)}
                className={cn(
                  "px-3 py-1 rounded-lg font-label-md text-label-md",
                  active === a ? "bg-surface-container-lowest font-bold shadow-sm" : "text-on-surface-variant",
                )}
              >
                {t(`users.filter.${a}`)}
              </button>
            ))}
          </div>
          {users && (
            <span className="ms-auto bg-secondary-fixed/50 text-secondary font-label-md text-label-md font-bold px-3 py-1.5 rounded-xl">
              {t("users.count", { n: users.length })}
            </span>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-start">
              <thead className="bg-surface-container-low text-secondary font-label-md text-label-md">
                <tr>
                  <th className="text-start px-space-md py-3">{t("users.col.name")}</th>
                  <th className="text-start px-space-md py-3">{t("users.col.username")}</th>
                  <th className="text-start px-space-md py-3">{t("users.col.roles")}</th>
                  <th className="text-start px-space-md py-3">{t("users.col.status")}</th>
                  <th className="text-start px-space-md py-3">{t("users.col.lastLogin")}</th>
                  <th className="px-space-md py-3"></th>
                </tr>
              </thead>
              <tbody>
                {!users && (
                  <tr>
                    <td colSpan={6} className="px-space-md py-6 text-outline">
                      {t("common.loading")}
                    </td>
                  </tr>
                )}
                {users?.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-space-md py-6 text-outline">
                      {t("users.none")}
                    </td>
                  </tr>
                )}
                {users?.map((u) => (
                  <tr key={u.id} className="border-t border-surface-container hover:bg-primary/5">
                    <td className="px-space-md py-3">
                      <div className="flex items-center gap-3">
                        <span
                          className={cn(
                            "w-9 h-9 shrink-0 rounded-full flex items-center justify-center font-label-md text-label-md font-bold",
                            u.active ? "bg-secondary-fixed text-on-secondary-fixed" : "bg-surface-variant text-outline",
                          )}
                          aria-hidden
                        >
                          {initials(u.display_name || u.username)}
                        </span>
                        <span className="font-bold text-on-surface">{u.display_name || "—"}</span>
                      </div>
                    </td>
                    <td className="px-space-md py-3 font-data-mono-sm text-data-mono-sm" dir="ltr">
                      {u.username}
                    </td>
                    <td className="px-space-md py-3">
                      <div className="flex flex-wrap gap-1">
                        {rolesOf(u).map((r) => (
                          <Badge key={r} tone={r === "admin" ? "processing" : "neutral"}>
                            {roleLabel(t, r)}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-space-md py-3">
                      <Badge tone={u.active ? "success" : "neutral"}>
                        {u.active ? t("users.active") : t("users.inactive")}
                      </Badge>
                    </td>
                    <td className="px-space-md py-3 text-on-surface-variant font-body-sm text-body-sm">
                      {u.last_login_at ? timeAgo(u.last_login_at, locale) : t("users.never")}
                    </td>
                    <td className="px-space-md py-3">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          title={t("users.edit")}
                          className="w-8 h-8 rounded-lg hover:bg-surface-container text-secondary flex items-center justify-center"
                          onClick={() => openEdit(u)}
                        >
                          <Icon name="edit" className="text-[18px]" />
                        </button>
                        <button
                          type="button"
                          title={t("users.resetPassword")}
                          className="w-8 h-8 rounded-lg hover:bg-surface-container text-secondary flex items-center justify-center"
                          onClick={() => openEdit(u, true)}
                        >
                          <Icon name="lock_reset" className="text-[18px]" />
                        </button>
                        {u.active ? (
                          <button
                            type="button"
                            title={t("users.deactivate")}
                            className="w-8 h-8 rounded-lg hover:bg-error-container text-error flex items-center justify-center"
                            onClick={() => setConfirmOff(u)}
                          >
                            <Icon name="person_off" className="text-[18px]" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            title={t("users.reactivate")}
                            className="w-8 h-8 rounded-lg hover:bg-primary/10 text-primary flex items-center justify-center"
                            onClick={() => reactivate(u)}
                          >
                            <Icon name="person_check" className="text-[18px]" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {rolesInfo && (
          <Card>
            <CardHeader
              icon="admin_panel_settings"
              title={t("users.matrixTitle")}
              hint={t("users.matrixHint")}
              action={
                <Button variant="ghost" size="sm" onClick={() => setShowMatrix((v) => !v)}>
                  <Icon name={showMatrix ? "expand_less" : "expand_more"} className="text-[18px]" />
                </Button>
              }
            />
            {showMatrix && (
              <div className="px-space-lg pb-space-lg overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-secondary font-label-md text-label-md">
                      <th className="text-start py-2">{t("users.permission")}</th>
                      {rolesInfo.roles.map((r) => (
                        <th key={r} className="py-2 px-2">
                          {roleLabel(t, r)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...new Set(Object.values(rolesInfo.permissions).flat())].map((p) => {
                      const key = `users.perm.${p}`;
                      return (
                      <tr key={p} className="border-t border-surface-container">
                        <td className="py-2 font-body-md text-body-md">{hasKey(key) ? t(key) : p}</td>
                        {rolesInfo.roles.map((r) => (
                          <td key={r} className="text-center py-2">
                            {rolesInfo.permissions[r]?.includes(p) ? (
                              <Icon name="check_circle" className="text-primary text-[18px]" />
                            ) : (
                              <span className="text-outline-variant">—</span>
                            )}
                          </td>
                        ))}
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>

      {/* Edit / create drawer */}
      <DialogPrimitive.Root open={!!draft} onOpenChange={(o) => !o && (setDraft(null), setError(null))}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" />
          <DialogPrimitive.Content
            dir={dir}
            className="fixed top-0 bottom-0 end-0 z-50 w-[min(100vw,28rem)] bg-surface-container-lowest shadow-2xl p-space-lg overflow-y-auto"
          >
            {draft && (
              <form onSubmit={save} className="flex flex-col gap-space-md">
                <div className="flex items-center justify-between">
                  <DialogPrimitive.Title className="font-headline-md text-headline-md font-bold text-on-surface">
                    {draft.id === null ? t("users.new") : t("users.editTitle")}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Close className="w-8 h-8 rounded-lg hover:bg-surface-container flex items-center justify-center">
                    <Icon name="close" className="text-[20px]" />
                  </DialogPrimitive.Close>
                </div>
                <DialogPrimitive.Description className="font-body-sm text-body-sm text-on-surface-variant">
                  {t("users.drawerHint")}
                </DialogPrimitive.Description>

                <label className="flex flex-col gap-1">
                  <span className="font-label-md text-label-md font-bold">{t("users.col.name")}</span>
                  <Input
                    value={draft.display_name}
                    onChange={(e) => setDraft({ ...draft, display_name: e.target.value })}
                    required
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-label-md text-label-md font-bold">{t("users.col.username")}</span>
                  <Input
                    value={draft.username}
                    dir="ltr"
                    onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                    required
                  />
                </label>
                {draft.id === null && (
                  <label className="flex flex-col gap-1">
                    <span className="font-label-md text-label-md font-bold">{t("users.password")}</span>
                    <Input
                      type="password"
                      value={draft.password}
                      minLength={6}
                      onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                      required
                    />
                  </label>
                )}

                <fieldset className="flex flex-col gap-2 border-0 p-0 m-0">
                  <legend className="font-label-md text-label-md font-bold mb-1">{t("users.col.roles")}</legend>
                  {ROLE_ORDER.map((r) => (
                    <label key={r} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="accent-primary w-4 h-4"
                        checked={draft.roles.includes(r)}
                        onChange={() => toggleRole(r)}
                      />
                      <span className="font-body-md text-body-md">{roleLabel(t, r)}</span>
                    </label>
                  ))}
                </fieldset>

                {draft.id !== null && (
                  <>
                    <label className="flex items-center justify-between gap-2 cursor-pointer">
                      <span className="font-label-md text-label-md font-bold">{t("users.active")}</span>
                      <input
                        type="checkbox"
                        className="accent-primary w-5 h-5"
                        checked={draft.active}
                        onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
                      />
                    </label>
                    <div className="flex flex-col gap-1 rounded-xl bg-surface-container-low p-3">
                      <span className="font-label-md text-label-md font-bold">{t("users.resetPassword")}</span>
                      <div className="flex gap-2">
                        <Input
                          type="password"
                          value={newPassword}
                          minLength={6}
                          placeholder={t("users.newPassword")}
                          autoFocus={focusReset}
                          onChange={(e) => setNewPassword(e.target.value)}
                        />
                        <Button type="button" variant="outline" onClick={resetPassword} disabled={newPassword.length < 6}>
                          {t("users.resetPasswordAction")}
                        </Button>
                      </div>
                    </div>
                  </>
                )}

                <div className="flex items-start gap-2 rounded-lg bg-secondary/5 text-secondary p-3 font-body-sm text-body-sm">
                  <Icon name="info" className="text-[18px] shrink-0" />
                  {t("users.softDeleteNote")}
                </div>

                {error && <div className="rounded-lg bg-error-container text-on-error-container px-3 py-2">{error}</div>}

                <div className="flex gap-2 pt-2">
                  <Button type="submit" disabled={draft.roles.length === 0}>
                    {t("users.save")}
                  </Button>
                  <DialogPrimitive.Close asChild>
                    <Button type="button" variant="outline">
                      {t("common.cancel")}
                    </Button>
                  </DialogPrimitive.Close>
                </div>
              </form>
            )}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <ConfirmDialog
        open={!!confirmOff}
        onOpenChange={(o) => !o && setConfirmOff(null)}
        title={t("users.deactivateTitle")}
        description={t("users.deactivateDesc", { name: confirmOff?.display_name || confirmOff?.username || "" })}
        confirmLabel={t("users.deactivate")}
        destructive
        onConfirm={() => confirmOff && deactivate(confirmOff)}
      />
    </div>
  );
}
