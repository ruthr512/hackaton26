import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { homeFor, useAuth } from "@/auth/AuthProvider";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const LOGO = "/logo.svg";
const DEMO_USERS = ["intake1", "approver1", "manager1", "admin1"];
const DEMO_PASSWORD = "demo1234"; // default of DEMO_PASSWORD in the backend settings

function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`}>{name}</span>;
}

export function LoginPage() {
  const { user, login } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const next = params.get("next");
  const target = (u: Parameters<typeof homeFor>[0]) => (next && next.startsWith("/") && next !== "/login" ? next : homeFor(u));

  if (user) return <Navigate to={target(user)} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(false);
    try {
      const u = await login(username, password);
      navigate(target(u), { replace: true });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-surface grid grid-cols-1 lg:grid-cols-2">
      <section className="hidden lg:flex flex-col justify-center gap-space-xl px-16 bg-gradient-to-br from-[#2BB99B] to-[#2B296D] text-on-primary">
        <div className="flex items-center gap-space-sm">
          <img alt="MedScan AI" className="h-10 w-auto object-contain" src={LOGO} />
          <span className="font-headline-lg text-headline-lg font-bold tracking-tight">MedScan AI</span>
        </div>
        <h1 className="font-display-lg text-display-lg font-extrabold max-w-md">{t("login.heroTitle")}</h1>
        <ul className="flex flex-col gap-space-md">
          {(
            [
              ["auto_awesome", "login.hero1"],
              ["draw", "login.hero2"],
              ["verified", "login.hero3"],
            ] as const
          ).map(([icon, key]) => (
            <li key={key} className="flex items-center gap-space-sm font-body-lg text-body-lg">
              <span className="w-10 h-10 rounded-full bg-white/15 flex items-center justify-center">
                <Icon name={icon} className="text-[22px] text-primary-fixed" />
              </span>
              {t(key)}
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col items-center justify-center px-4 py-space-xl gap-space-lg">
        <form
          onSubmit={submit}
          className="w-full max-w-sm bg-surface-container-lowest rounded-[20px] border border-[rgba(43,41,109,0.06)] shadow-[0_10px_30px_-5px_rgba(43,41,109,0.07)] p-space-lg flex flex-col gap-space-md"
        >
          <div className="flex flex-col gap-1">
            <h2 className="font-headline-lg text-headline-lg font-bold text-navy">{t("login.title")}</h2>
            <p className="font-body-md text-body-md text-on-surface-variant">{t("login.subtitle")}</p>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="font-label-md text-label-md text-navy">{t("login.username")}</span>
            <Input
              autoFocus
              autoComplete="username"
              dir="ltr"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              aria-invalid={error}
              required
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-label-md text-label-md text-navy">{t("login.password")}</span>
            <Input
              type="password"
              autoComplete="current-password"
              dir="ltr"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error}
              required
            />
          </label>
          {error && (
            <p role="alert" className="flex items-center gap-1.5 font-body-sm text-body-sm text-tertiary font-bold">
              <Icon name="error" className="text-[18px]" />
              {t("login.error")}
            </p>
          )}
          <Button type="submit" disabled={busy} className="w-full h-11">
            {busy ? t("common.loading") : t("login.submit")}
          </Button>
        </form>

        <div className="w-full max-w-sm rounded-xl bg-surface-container-low px-4 py-3 flex flex-wrap items-center gap-2">
          <span className="font-label-md text-label-md text-on-surface-variant">{t("login.demoHint")}:</span>
          {DEMO_USERS.map((u) => (
            <button
              key={u}
              type="button"
              onClick={() => {
                setUsername(u);
                setPassword(DEMO_PASSWORD);
              }}
              className="font-data-mono-sm text-data-mono-sm bg-white rounded-full px-2.5 py-0.5 text-navy ring-1 ring-outline-variant hover:ring-primary-container"
              dir="ltr"
            >
              {u}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
