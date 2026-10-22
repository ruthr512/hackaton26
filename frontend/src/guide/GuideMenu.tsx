import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { roleLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useGuide } from "./GuideProvider";
import { GUIDE_STEPS, minutesFor } from "./steps";

/** The "?" button of the header and the menu under it that starts the guide. */
export function GuideMenu() {
  const { t } = useI18n();
  const { myRole, progress, openWelcome, startTour, resume } = useGuide();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const mySteps = GUIDE_STEPS[myRole].length;

  return (
    <div ref={root} className="relative" data-guide="help">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("header.help")}
        title={t("header.help")}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-full text-on-primary transition-colors",
          open ? "bg-white/30 ring-4 ring-primary-fixed/40" : "bg-white/10 hover:bg-white/20",
        )}
      >
        <span className="material-symbols-outlined text-[20px]">help_outline</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute end-0 top-full z-50 mt-3 w-[340px] max-w-[92vw] rounded-[20px] border border-secondary/10 bg-surface-container-lowest p-2 text-on-surface shadow-[0_16px_40px_-8px_rgba(43,41,109,0.25)]"
        >
          <div className="flex items-center gap-3 px-3 pb-2 pt-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-secondary/10 text-secondary">
              <span className="material-symbols-outlined text-[20px]">menu_book</span>
            </span>
            <div className="min-w-0">
              <div className="font-headline-sm text-headline-sm font-bold text-navy">{t("guide.help.title")}</div>
              <div className="font-body-sm text-body-sm text-on-surface-variant">{t("guide.help.subtitle")}</div>
            </div>
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={run(() => startTour(myRole))}
            className="flex w-full items-center gap-3 rounded-2xl border-2 border-primary-container/60 bg-primary-container/10 p-3 text-start hover:bg-primary-container/15"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-container text-white">
              <span className="material-symbols-outlined text-[22px]">explore</span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="font-body-md text-body-md font-bold text-navy">{t("guide.menu.myTour")}</span>
              </span>
              <span className="mt-0.5 flex items-center gap-2 font-body-sm text-body-sm text-on-surface-variant">
                <span className="rounded-full bg-secondary/10 px-2 py-0.5 font-label-sm text-label-sm font-bold text-secondary">
                  {roleLabel(t, myRole)}
                </span>
                {t("guide.menu.meta", { steps: t("guide.stepsCount", { count: mySteps }), minutes: minutesFor(myRole) })}
              </span>
            </span>
            <span className="rounded-full bg-primary-container px-3 py-1 font-label-md text-label-md font-bold text-white">
              {t("guide.menu.start")}
            </span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={run(openWelcome)}
            className="mt-1 flex w-full items-center gap-3 rounded-2xl p-3 text-start hover:bg-surface-container-low"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary/10 text-secondary">
              <span className="material-symbols-outlined text-[22px]">groups</span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-body-md text-body-md font-bold text-navy">{t("guide.menu.other")}</span>
              <span className="block font-body-sm text-body-sm text-on-surface-variant">{t("guide.menu.otherHint")}</span>
            </span>
            <span className="material-symbols-outlined text-[20px] text-outline rtl:rotate-180">chevron_right</span>
          </button>

          {progress && (
            <button
              type="button"
              role="menuitem"
              onClick={run(resume)}
              className="mt-1 flex w-full items-center gap-3 rounded-2xl p-3 text-start hover:bg-surface-container-low"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary/10 text-secondary">
                <span className="material-symbols-outlined text-[22px]">play_circle</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-body-md text-body-md font-bold text-navy">{t("guide.menu.resume")}</span>
                <span className="block font-body-sm text-body-sm text-on-surface-variant">
                  {t("guide.menu.resumeHint", {
                    role: roleLabel(t, progress.role),
                    step: progress.step + 1,
                    total: GUIDE_STEPS[progress.role].length,
                  })}
                </span>
                <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-outline-variant/50">
                  <span
                    className="block h-full rounded-full bg-primary-container"
                    style={{ width: `${((progress.step + 1) / GUIDE_STEPS[progress.role].length) * 100}%` }}
                  />
                </span>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
