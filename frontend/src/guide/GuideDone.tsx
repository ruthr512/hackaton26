import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useI18n } from "@/i18n";
import type { Role } from "@/lib/api";
import { roleLabel } from "@/lib/labels";
import { GUIDE_STEPS } from "./steps";

interface Props {
  role: Role;
  onGo: (index: number) => void;
  onAgain: () => void;
  onClose: () => void;
}

/** Shown after the last step: what was covered, each with a way back to that screen. */
export function GuideDone({ role, onGo, onAgain, onClose }: Props) {
  const { t, dir } = useI18n();
  const steps = GUIDE_STEPS[role];

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[100] bg-[rgba(43,41,109,0.55)] backdrop-blur-sm" />
        <DialogPrimitive.Content
          dir={dir}
          className="fixed left-1/2 top-1/2 z-[101] max-h-[92vh] w-[min(94vw,35rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[20px] border-t-4 border-t-primary-container bg-white px-7 py-6 shadow-[0_24px_48px_-12px_rgba(43,41,109,0.35)]"
        >
          <div className="flex flex-col items-center text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-container/20 ring-8 ring-primary-container/10">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-container text-white">
                <span className="material-symbols-outlined text-[30px]">check</span>
              </span>
            </span>
            <DialogPrimitive.Title className="mt-3 font-headline-lg text-headline-lg font-bold text-navy">
              {t("guide.done.title")}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="font-body-md text-body-md text-on-surface-variant">
              {t("guide.done.subtitle")}
            </DialogPrimitive.Description>
            <span className="mt-3 flex items-center gap-2 rounded-full bg-surface-container-low px-3 py-1 font-label-md text-label-md text-navy">
              {t("guide.done.path", { role: roleLabel(t, role) })}
              <span className="rounded-full bg-primary-fixed px-2 py-0.5 font-label-sm text-label-sm font-bold text-on-primary-fixed">
                {t("guide.done.status")}
              </span>
            </span>
          </div>

          <h3 className="mb-2 mt-5 font-headline-sm text-headline-sm font-bold text-secondary">{t("guide.done.checklist")}</h3>
          <ul className="flex flex-col gap-2">
            {steps.map((s, i) => (
              <li key={i} className="flex items-center gap-3 rounded-xl border border-outline-variant/50 px-3 py-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-container/15 text-primary">
                  <span className="material-symbols-outlined text-[16px]">check</span>
                </span>
                <span className="min-w-0 flex-1 truncate font-body-md text-body-md font-bold text-navy">
                  {i + 1}. {t(s.title)}
                </span>
                <button
                  type="button"
                  onClick={() => onGo(i)}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 font-label-md text-label-md font-bold text-primary hover:bg-primary-container/10"
                >
                  {t("guide.done.go")}
                  <span className="material-symbols-outlined text-[16px] rtl:rotate-180">arrow_forward</span>
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-5 flex flex-col gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-[10px] bg-primary-container font-bold text-white shadow-md hover:bg-[#249f85]"
            >
              {t("guide.done.finish")}
            </button>
            <button
              type="button"
              onClick={onAgain}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-[10px] bg-white font-bold text-secondary ring-1 ring-outline-variant hover:bg-secondary/5"
            >
              <span className="material-symbols-outlined text-[18px]">replay</span>
              {t("guide.done.again")}
            </button>
          </div>
          <p className="mt-3 flex items-center justify-center gap-1.5 text-center font-body-sm text-body-sm text-on-surface-variant">
            <span className="material-symbols-outlined text-[16px]">help</span>
            {t("guide.done.hint")}
          </p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
