import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import type { Role } from "@/lib/api";
import { rolesOf } from "@/lib/labels";
import { GuideDone } from "./GuideDone";
import { GuideTour } from "./GuideTour";
import { GuideWelcome } from "./GuideWelcome";
import { GUIDE_STEPS, canOpen } from "./steps";

interface Progress {
  role: Role;
  step: number;
}

interface Guide {
  /** The tour that fits the user best: their own screen first. */
  myRole: Role;
  /** Where the user stopped, if a tour was left half-way. */
  progress: Progress | null;
  openWelcome: () => void;
  startTour: (role: Role, step?: number) => void;
  resume: () => void;
}

const GuideContext = createContext<Guide | null>(null);

type Phase = "idle" | "welcome" | "tour" | "done";

/** Manager before the clerk before the approver; the system admin only when they hold nothing else (as homeFor does). */
const MY_ROLE_ORDER: Role[] = ["lab_manager", "intake", "approver", "admin"];

function read(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null; // storage blocked
  }
}

function write(storage: Storage | undefined, key: string, value: string | null) {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch {
    /* storage blocked: the choice lasts for this visit only */
  }
}

export function GuideProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const roles = rolesOf(user);
  const uid = user?.id ?? "anon";
  const myRole = MY_ROLE_ORDER.find((r) => roles.includes(r)) ?? "intake";

  const progressKey = `guide.progress.${uid}`;
  const hiddenKey = `guide.hidden.${uid}`;
  const seenKey = `guide.seen.${uid}`;

  const [phase, setPhase] = useState<Phase>("idle");
  const [role, setRole] = useState<Role>(myRole);
  const [step, setStep] = useState(0);
  const [progress, setProgress] = useState<Progress | null>(null);

  // what was saved for this user, and the welcome screen the first time (until they ask not to see it)
  useEffect(() => {
    if (!user) return;
    try {
      const saved = JSON.parse(read(localStorage, progressKey) ?? "null") as Progress | null;
      setProgress(saved && GUIDE_STEPS[saved.role]?.[saved.step] ? saved : null);
    } catch {
      setProgress(null);
    }
    if (!read(localStorage, hiddenKey) && !read(sessionStorage, seenKey)) {
      write(sessionStorage, seenKey, "1");
      setRole(myRole);
      setPhase("welcome");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const save = useCallback(
    (p: Progress | null) => {
      setProgress(p);
      write(localStorage, progressKey, p ? JSON.stringify(p) : null);
    },
    [progressKey],
  );

  const startTour = useCallback(
    (r: Role, s = 0) => {
      setRole(r);
      setStep(s);
      setPhase("tour");
      save({ role: r, step: s });
    },
    [save],
  );

  const goTo = useCallback(
    (s: number) => {
      setStep(s);
      save({ role, step: s });
    },
    [role, save],
  );

  // the tour walks the user to the screen of each step (unless that screen is closed to their account)
  useEffect(() => {
    if (phase !== "tour") return;
    const route = GUIDE_STEPS[role][step].route;
    if (canOpen(route, roles) && window.location.pathname !== route) navigate(route);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, role, step]);

  const value = useMemo<Guide>(
    () => ({
      myRole,
      progress,
      openWelcome: () => {
        setRole(progress?.role ?? myRole);
        setPhase("welcome");
      },
      startTour,
      resume: () => progress && startTour(progress.role, progress.step),
    }),
    [myRole, progress, startTour],
  );

  const steps = GUIDE_STEPS[role];

  return (
    <GuideContext.Provider value={value}>
      {children}
      {phase === "welcome" && (
        <GuideWelcome
          mine={roles}
          initial={role}
          onStart={(r, dontShow) => {
            if (dontShow) write(localStorage, hiddenKey, "1");
            startTour(r);
          }}
          onClose={(dontShow) => {
            if (dontShow) write(localStorage, hiddenKey, "1");
            setPhase("idle");
          }}
        />
      )}
      {phase === "tour" && (
        <GuideTour
          role={role}
          step={step}
          restricted={!canOpen(steps[step].route, roles)}
          onPrev={() => step > 0 && goTo(step - 1)}
          onNext={() => {
            if (step < steps.length - 1) goTo(step + 1);
            else {
              save(null);
              setPhase("done");
            }
          }}
          onJump={goTo}
          onClose={() => setPhase("idle")}
        />
      )}
      {phase === "done" && (
        <GuideDone
          role={role}
          onGo={(i) => {
            const s = steps[i];
            if (canOpen(s.route, roles)) navigate(s.route);
            setPhase("idle");
          }}
          onAgain={() => startTour(role)}
          onClose={() => setPhase("idle")}
        />
      )}
    </GuideContext.Provider>
  );
}

export function useGuide(): Guide {
  const ctx = useContext(GuideContext);
  if (!ctx) throw new Error("useGuide must be used inside <GuideProvider>");
  return ctx;
}
