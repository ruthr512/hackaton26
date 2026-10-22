import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { LANGS, useI18n, type Lang, type MessageKey } from "@/i18n";
import { homeFor, useAuth } from "@/auth/AuthProvider";
import type { Role } from "@/lib/api";
import { hasRole, rolesOf } from "@/lib/labels";
import { GuideProvider } from "@/guide/GuideProvider";
import { GuideMenu } from "@/guide/GuideMenu";

const LOGO = "/logo.svg";

/** The personal-area links of each role, shown outside the batch screens. */
const ROLE_LINKS: Record<Role, { to: string; label: MessageKey }[]> = {
  intake: [
    { to: "/me", label: "nav.myQueue" },
    { to: "/", label: "nav.newUpload" },
    { to: "/patients", label: "nav.patients" },
  ],
  approver: [
    { to: "/me", label: "nav.approvals" },
    { to: "/patients", label: "nav.patients" },
  ],
  lab_manager: [
    { to: "/dashboard", label: "nav.dashboard" },
    { to: "/", label: "nav.newUpload" },
    { to: "/patients", label: "nav.patients" },
    { to: "/rules", label: "nav.rules" },
  ],
  admin: [
    { to: "/admin/users", label: "nav.users" },
    { to: "/rules", label: "nav.rules" },
    { to: "/patients", label: "nav.patients" },
  ],
};

/** Anchors for the user guide on the four steps of the batch stepper. */
const STEP_ANCHORS = ["step-upload", "step-processing", "step-review", "step-export"];

/** The links of every role the user holds, each once (in role order). */
function linksFor(roles: Role[]) {
  const seen = new Set<string>();
  return roles.flatMap((r) => ROLE_LINKS[r] ?? []).filter((l) => !seen.has(l.to) && seen.add(l.to));
}

const initials = (name: string) =>
  name
    .replace(/["״׳']/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(-2)
    .map((w) => w[0])
    .join("");

const ACTIVE = "px-4 py-1.5 rounded-full transition-all bg-white/25 text-on-primary font-bold shadow-sm";
const INACTIVE =
  "text-primary-fixed-dim hover:text-on-primary hover:bg-white/10 px-4 py-1.5 rounded-full text-label-md font-label-md transition-all";

function LanguageSwitcher() {
  const { lang, setLang, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const current = LANGS.find((l) => l.code === lang) ?? LANGS[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = () => {
    setActive(Math.max(0, LANGS.findIndex((l) => l.code === lang)));
    setOpen((o) => !o);
  };
  const pick = (code: Lang) => {
    setLang(code);
    setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") return setOpen(false);
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        toggle();
      }
      return;
    }
    if (e.key === "ArrowDown") setActive((i) => (i + 1) % LANGS.length);
    else if (e.key === "ArrowUp") setActive((i) => (i - 1 + LANGS.length) % LANGS.length);
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(LANGS.length - 1);
    else if (e.key === "Enter" || e.key === " ") pick(LANGS[active].code);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("lang.label")}
        title={t("lang.label")}
        onClick={toggle}
        className={`flex items-center gap-1.5 rounded-full ps-2.5 pe-2 h-9 text-on-primary transition-colors ${
          open ? "bg-white/25" : "bg-white/10 hover:bg-white/20"
        }`}
      >
        <span className="material-symbols-outlined text-[18px] text-primary-fixed" aria-hidden>
          translate
        </span>
        <span className="font-label-md text-label-md font-bold" lang={current.code}>
          {current.name}
        </span>
        <span
          className={`material-symbols-outlined text-[18px] transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          aria-hidden
        >
          expand_more
        </span>
      </button>
      {open && (
        <div className="absolute end-0 top-full mt-2 w-56 p-1.5 rounded-2xl bg-surface-container-lowest border border-secondary/10 shadow-[0_16px_40px_-8px_rgba(43,41,109,0.18)] z-50">
          <div className="px-3 pt-1.5 pb-2 font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant/70">
            {t("lang.label")}
          </div>
          <ul role="listbox" aria-label={t("lang.label")} className="flex flex-col gap-0.5">
            {LANGS.map((l, i) => {
              const selected = l.code === lang;
              return (
                <li key={l.code} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    lang={l.code}
                    onClick={() => pick(l.code)}
                    onMouseEnter={() => setActive(i)}
                    className={`w-full h-11 flex items-center gap-3 rounded-[10px] px-2.5 text-start transition-colors ${
                      selected ? "bg-primary-container/15 text-secondary font-bold" : "text-on-surface"
                    } ${i === active && !selected ? "bg-primary-container/10" : ""}`}
                  >
                    <span
                      dir="ltr"
                      className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center font-data-mono-sm text-data-mono-sm uppercase ${
                        selected ? "bg-primary-container text-on-primary" : "bg-primary-container/15 text-primary"
                      }`}
                    >
                      {l.code}
                    </span>
                    <span className="flex-1 font-body-md text-body-md">{l.name}</span>
                    {selected && (
                      <span className="material-symbols-outlined text-[20px] text-primary" aria-hidden>
                        check
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const id = useMatch("/batches/:id/*")?.params.id;
  const { pathname } = useLocation();
  const { t } = useI18n();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const roles = rolesOf(user);
  const step = pathname === "/" ? 0 : pathname.endsWith("/processing") ? 1 : pathname.endsWith("/export") ? 3 : 2;
  const steps = [
    { to: hasRole(user, "intake", "lab_manager") ? "/" : "", label: t("nav.upload") },
    { to: id ? `/batches/${id}/processing` : "", label: t("nav.processing") },
    { to: id ? `/batches/${id}` : "", label: t("nav.review") },
    { to: id && hasRole(user, "lab_manager", "approver", "intake") ? `/batches/${id}/export` : "", label: t("nav.export") },
  ];
  const inBatchFlow = pathname === "/" || !!id;
  const roleLinks = linksFor(roles.length ? roles : ["intake"]);

  return (
    <GuideProvider>
      <header className="fixed top-0 w-full z-50 shadow-[0_10px_25px_-5px_rgba(43,41,109,0.06)] bg-gradient-to-br from-[#2BB99B] to-[#2B296D]">
        <div className="h-20 w-full px-margin flex items-center justify-between">
          <div className="flex items-center gap-space-md">
            <img alt="MedScan AI" className="h-8 w-auto object-contain" src={LOGO} />
            <div className="flex flex-col">
              <div className="flex items-center gap-space-xs">
                <span className="text-on-primary font-headline-md text-headline-md tracking-tight font-bold">MedScan AI</span>
              </div>
              <span className="text-primary-fixed font-body-sm text-body-sm opacity-90">{t("header.tagline")}</span>
            </div>
          </div>
          <nav className="hidden xl:flex items-center bg-black/15 rounded-full p-1.5 gap-1">
            {!inBatchFlow &&
              roleLinks.map((l) => (
                <Link key={l.to} to={l.to} aria-current={pathname === l.to ? "page" : undefined}
                      className={pathname === l.to || (l.to !== "/" && pathname.startsWith(l.to + "/")) ? ACTIVE : INACTIVE}>
                  {t(l.label)}
                </Link>
              ))}
            {inBatchFlow && (
              <Link to={user ? homeFor(user) : "/me"} className={INACTIVE} title={t(roleLinks[0].label)}>
                <span className="material-symbols-outlined text-[18px] align-middle">home</span>
              </Link>
            )}
            {inBatchFlow && steps.map((s, i) => (
              <Link
                key={i}
                to={s.to || "#"}
                data-guide={STEP_ANCHORS[i]}
                onClick={s.to ? undefined : (e) => e.preventDefault()}
                aria-current={i === step ? "page" : undefined}
                className={i === step ? ACTIVE : INACTIVE}
              >
                {s.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-space-md">
            <LanguageSwitcher />
            <GuideMenu />
            {user && (
              <div className="flex items-center gap-space-sm pe-2">
                <div className="text-end hidden sm:flex flex-col">
                  <span className="text-on-primary font-label-md text-label-md">{user.display_name || user.username}</span>
                  <span className="text-primary-fixed-dim font-body-sm text-body-sm">
                    {roles.map((r) => t(`role.${r}`)).join(" · ")}
                  </span>
                </div>
                <span
                  aria-label={t("header.profile")}
                  className="w-8 h-8 rounded-full bg-white/25 text-on-primary flex items-center justify-center font-label-md text-label-md font-bold"
                >
                  {initials(user.display_name || user.username)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    logout();
                    navigate("/login", { replace: true });
                  }}
                  className="flex items-center justify-center w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-on-primary transition-colors"
                  aria-label={t("header.logout")}
                  title={t("header.logout")}
                >
                  <span className="material-symbols-outlined text-[20px]">logout</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main className="w-full pt-20 bg-surface min-h-[calc(100vh-80px)]">
        <div className="flex flex-col w-full">
          <Outlet />
        </div>
      </main>
      <footer className="w-full bg-surface-container-low shadow-[0_1px_8px_rgba(0,0,0,0.04)] py-space-md">
        <div className="w-full px-margin flex flex-col md:flex-row items-center justify-between gap-space-sm text-on-surface-variant font-body-sm text-body-sm">
          <div className="flex items-center gap-space-sm">
            <span className="material-symbols-outlined text-primary text-[18px]">lock</span>
            <span>{t("footer.encrypted")}</span>
          </div>
          <div className="flex items-center gap-space-lg">
            <a className="hover:text-primary transition-colors" href="#">
              {t("footer.privacy")}
            </a>
            <a className="hover:text-primary transition-colors" href="#">
              {t("footer.support")}
            </a>
            <span className="font-data-mono-sm text-data-mono-sm" dir="ltr">
              © 2026 MedScan AI Ltd. All rights reserved.
            </span>
          </div>
        </div>
      </footer>
    </GuideProvider>
  );
}
