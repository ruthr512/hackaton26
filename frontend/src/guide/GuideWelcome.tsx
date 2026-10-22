import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useState } from "react";
import { useI18n } from "@/i18n";
import type { Role } from "@/lib/api";
import { roleLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { GUIDE_ROLES, GUIDE_STEPS } from "./steps";

const ROLE_ICON: Record<Role, string> = {
  intake: "upload_file",
  approver: "fact_check",
  lab_manager: "monitoring",
  admin: "admin_panel_settings",
};

interface Props {
  /** Roles the signed-in user holds: they get the "your role" tag. */
  mine: Role[];
  initial: Role;
  onStart: (role: Role, dontShowAgain: boolean) => void;
  onClose: (dontShowAgain: boolean) => void;
}

/** The first screen of the guide: pick a role, then start its tour. */
export function GuideWelcome({ mine, initial, onStart, onClose }: Props) {
  const { t, dir } = useI18n();
  const [picked, setPicked] = useState<Role>(initial);
  const [dontShow, setDontShow] = useState(false);

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose(dontShow)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[100] bg-[rgba(43,41,109,0.55)] backdrop-blur-sm" />
        <DialogPrimitive.Content
          dir={dir}
          className="fixed left-1/2 top-1/2 z-[101] max-h-[92vh] w-[min(94vw,52rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[20px] bg-white shadow-[0_24px_48px_-12px_rgba(43,41,109,0.35)]"
        >
          <div className="relative bg-gradient-to-br from-[#2BB99B] to-[#2B296D] px-8 py-7 text-white">
            <DialogPrimitive.Close
              aria-label={t("common.close")}
              className="absolute end-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-white/20 hover:bg-white/30"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </DialogPrimitive.Close>
            <div className="flex items-center gap-4">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/30">
                <span className="material-symbols-outlined text-[30px]">tour</span>
              </span>
              <div>
                <span className="rounded-full bg-white/20 px-2.5 py-0.5 font-label-sm text-label-sm">{t("guide.welcome.badge")}</span>
                <DialogPrimitive.Title className="mt-1 font-headline-lg text-headline-lg font-bold">
                  {t("guide.welcome.title")}
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="font-body-md text-body-md text-white/90">
                  {t("guide.welcome.subtitle")}
                </DialogPrimitive.Description>
              </div>
            </div>
          </div>

          <div className="px-8 py-6">
            <h3 className="mb-3 font-headline-sm text-headline-sm font-bold text-secondary">{t("guide.welcome.pick")}</h3>
            <div role="radiogroup" aria-label={t("guide.welcome.pick")} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {GUIDE_ROLES.map((r) => {
                const on = r === picked;
                const count = GUIDE_STEPS[r].length;
                return (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setPicked(r)}
                    onDoubleClick={() => onStart(r, dontShow)}
                    className={cn(
                      "flex flex-col gap-2 rounded-2xl border-2 p-4 text-start transition-all",
                      on ? "border-primary-container bg-primary-container/10 shadow-md" : "border-outline-variant/60 bg-white hover:border-primary-container/60",
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", on ? "bg-primary-container text-white" : "bg-secondary/10 text-secondary")}>
                        <span className="material-symbols-outlined text-[22px]">{ROLE_ICON[r]}</span>
                      </span>
                      <span className="font-headline-sm text-headline-sm font-bold text-navy">{roleLabel(t, r)}</span>
                      {mine.includes(r) && (
                        <span className="ms-auto flex items-center gap-1 rounded-full bg-primary-container px-2 py-0.5 font-label-sm text-label-sm font-bold text-white">
                          <span className="material-symbols-outlined text-[14px]">check</span>
                          {t("guide.welcome.yours")}
                        </span>
                      )}
                    </div>
                    <p className="font-body-md text-body-md text-on-surface-variant">{t(`guide.roleDesc.${r}`)}</p>
                    <div className="flex items-center gap-1.5 font-label-sm text-label-sm text-on-surface-variant">
                      <span className="material-symbols-outlined text-[16px]">footprint</span>
                      {t("guide.stepsCount", { count })}
                    </div>
                  </button>
                );
              })}
            </div>
            <p className="mt-4 flex items-center gap-2 rounded-xl bg-surface-container-low px-3 py-2 font-body-sm text-body-sm text-on-surface-variant">
              <span className="material-symbols-outlined text-[18px] text-secondary">info</span>
              {t("guide.welcome.note")}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-outline-variant/40 px-8 py-4">
            <button
              type="button"
              onClick={() => onStart(picked, dontShow)}
              className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-primary-container px-5 font-bold text-white shadow-md hover:bg-[#249f85]"
            >
              <span className="material-symbols-outlined text-[18px]">tour</span>
              {t("guide.welcome.start")}
            </button>
            <button
              type="button"
              onClick={() => onClose(dontShow)}
              className="inline-flex h-10 items-center rounded-[10px] bg-white px-4 font-bold text-secondary ring-1 ring-outline-variant hover:bg-secondary/5"
            >
              {t("guide.welcome.later")}
            </button>
            <label className="ms-auto flex cursor-pointer items-center gap-2 font-body-sm text-body-sm text-on-surface-variant">
              <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} className="h-4 w-4 accent-[#2BB99B]" />
              {t("guide.welcome.dontShow")}
            </label>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
