import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/i18n";
import type { Role } from "@/lib/api";
import { roleLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { GUIDE_STEPS, rolesFor } from "./steps";

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PAD = 8;
const GAP = 14;
const MARGIN = 16;
const HEADER = 88;

/** Follows the highlighted element every frame, so it stays put while the page loads, resizes or scrolls. */
function useTargetRect(selector: string | null, stepKey: string): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useEffect(() => {
    setRect(null);
    if (!selector) return;
    let raf = 0;
    let scrolled = false;
    let last = "";
    const tick = () => {
      let next: Rect | null = null;
      // "a || b": the first selector that matches wins (e.g. a table row, else the whole table)
      const el = selector
        .split("||")
        .map((s) => document.querySelector<HTMLElement>(s.trim()))
        .find((e) => e && e.getBoundingClientRect().width > 0);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          next = { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
          if (!scrolled && !el.closest("header")) {
            scrolled = true;
            if (r.top < HEADER || r.bottom > window.innerHeight - MARGIN) el.scrollIntoView({ block: "center" });
          }
        }
      }
      const sig = next ? `${next.top},${next.left},${next.width},${next.height}` : "";
      if (sig !== last) {
        last = sig;
        setRect(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [selector, stepKey]);
  return rect;
}

type Side = "bottom" | "top" | "right" | "left" | "none";

/** Puts the card next to the highlighted element on the first side with room; centred when there is no element. */
function place(rect: Rect | null, w: number, h: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!rect) return { side: "none" as Side, top: Math.max(MARGIN, (vh - h) / 2), left: Math.max(MARGIN, (vw - w) / 2), arrow: 0 };
  const s = { top: rect.top - PAD, left: rect.left - PAD, right: rect.left + rect.width + PAD, bottom: rect.top + rect.height + PAD };
  const cx = (s.left + s.right) / 2;
  const cy = (s.top + s.bottom) / 2;
  const clampX = (x: number) => Math.min(Math.max(x, MARGIN), vw - w - MARGIN);
  const clampY = (y: number) => Math.min(Math.max(y, HEADER), vh - h - MARGIN);
  if (s.bottom + GAP + h <= vh - MARGIN) {
    const left = clampX(cx - w / 2);
    return { side: "bottom" as Side, top: s.bottom + GAP, left, arrow: cx - left };
  }
  if (s.top - GAP - h >= HEADER) {
    const left = clampX(cx - w / 2);
    return { side: "top" as Side, top: s.top - GAP - h, left, arrow: cx - left };
  }
  if (s.right + GAP + w <= vw - MARGIN) {
    const top = clampY(cy - h / 2);
    return { side: "right" as Side, top, left: s.right + GAP, arrow: cy - top };
  }
  if (s.left - GAP - w >= MARGIN) {
    const top = clampY(cy - h / 2);
    return { side: "left" as Side, top, left: s.left - GAP - w, arrow: cy - top };
  }
  return { side: "none" as Side, top: clampY(vh - h - MARGIN), left: clampX(cx - w / 2), arrow: 0 };
}

interface Props {
  role: Role;
  step: number;
  /** The signed-in user cannot open this step's screen: only the explanation is shown. */
  restricted: boolean;
  onPrev: () => void;
  onNext: () => void;
  onJump: (index: number) => void;
  onClose: () => void;
}

export function GuideTour({ role, step, restricted, onPrev, onNext, onJump, onClose }: Props) {
  const { t, dir } = useI18n();
  const steps = GUIDE_STEPS[role];
  const def = steps[step];
  const last = step === steps.length - 1;
  const rect = useTargetRect(restricted ? null : def.target, `${role}:${step}`);
  const card = useRef<HTMLDivElement>(null);
  const nextBtn = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState({ w: 380, h: 360 });
  const [, setViewport] = useState(0);

  // measure the card after every render, but only update when it really changed (else this would loop)
  useLayoutEffect(() => {
    const el = card.current;
    if (el && (el.offsetWidth !== size.w || el.offsetHeight !== size.h)) setSize({ w: el.offsetWidth, h: el.offsetHeight });
  });
  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => nextBtn.current?.focus(), [role, step]);

  const pos = place(rect, size.w, size.h);
  const forward = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
  const backward = dir === "rtl" ? "ArrowRight" : "ArrowLeft";

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Tab" && card.current) {
      // keep the focus inside the card
      const items = card.current.querySelectorAll<HTMLElement>("button:not([disabled])");
      const first = items[0];
      const end = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        end.focus();
      } else if (!e.shiftKey && document.activeElement === end) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (e.key === "Escape") onClose();
    else if (e.key === forward) onNext();
    else if (e.key === backward) {
      if (step > 0) onPrev();
    } else return;
    e.preventDefault();
  }

  const arrowStyle =
    pos.side === "bottom" || pos.side === "top"
      ? { left: pos.arrow - 7 }
      : pos.side === "left" || pos.side === "right"
        ? { top: pos.arrow - 7 }
        : undefined;
  const arrowEdge = { bottom: "-top-[7px]", top: "-bottom-[7px]", right: "-left-[7px]", left: "-right-[7px]", none: "" }[pos.side];

  return createPortal(
    <div className="fixed inset-0 z-[100]" onKeyDown={onKeyDown}>
      {/* swallows clicks so the page behind stays as it is during the tour */}
      <div className={cn("absolute inset-0", !rect && "bg-[rgba(43,41,109,0.55)]")} />
      {rect && (
        <div
          aria-hidden
          className="pointer-events-none absolute rounded-2xl transition-all duration-200 ease-out shadow-[0_0_0_9999px_rgba(43,41,109,0.55),0_0_0_3px_#2bb99b,0_0_26px_6px_rgba(43,185,155,0.45)]"
          style={{ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }}
        />
      )}
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={t("guide.tour.label")}
        dir={dir}
        className="absolute rounded-[20px] bg-white p-5 shadow-[0_16px_40px_-8px_rgba(43,41,109,0.35)] transition-[top,left] duration-200 ease-out"
        style={{ top: pos.top, left: pos.left, width: Math.min(380, window.innerWidth - MARGIN * 2) }}
      >
        {pos.side !== "none" && (
          <span aria-hidden className={cn("absolute h-[14px] w-[14px] rotate-45 bg-white", arrowEdge)} style={arrowStyle} />
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-primary-container/15 px-2.5 py-1 font-label-md text-label-md font-bold text-primary">
              {t("guide.tour.step", { step: step + 1, total: steps.length })}
            </span>
            <span className="rounded-full bg-secondary/10 px-2.5 py-1 font-label-md text-label-md font-bold text-secondary">
              {roleLabel(t, role)}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-8 w-8 items-center justify-center rounded-full text-outline hover:bg-surface-container"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <h2 className="mt-3 font-headline-md text-headline-md font-bold text-navy">{t(def.title)}</h2>
        <p className="mt-1 font-body-md text-body-md text-on-surface-variant">{t(def.body)}</p>

        {restricted && (
          <p className="mt-3 flex gap-2 rounded-xl bg-surface-container-low px-3 py-2 font-body-sm text-body-sm text-on-surface-variant">
            <span className="material-symbols-outlined text-[18px] text-secondary">lock</span>
            <span>{t("guide.tour.restricted", { role: rolesFor(def.route).map((r) => roleLabel(t, r)).join(" / ") })}</span>
          </p>
        )}
        {def.tip && (
          <p className="mt-3 flex gap-2 rounded-xl border-s-4 border-primary-container bg-primary-container/10 px-3 py-2 font-body-sm text-body-sm text-on-primary-container">
            <span className="material-symbols-outlined text-[18px] text-primary">lightbulb</span>
            <span>
              <b>{t("guide.tour.tip")}: </b>
              {t(def.tip)}
            </span>
          </p>
        )}

        <div className="mt-4 flex items-center gap-1.5" aria-hidden>
          {steps.map((_, i) => (
            <span
              key={i}
              className={cn("h-1.5 rounded-full transition-all", i === step ? "w-6 bg-primary-container" : i < step ? "w-1.5 bg-primary-container/60" : "w-1.5 bg-outline-variant")}
            />
          ))}
        </div>

        <div className="mt-3 rounded-xl bg-surface-container-low p-2">
          <div className="px-1 pb-1.5 font-label-sm text-label-sm text-on-surface-variant">{t("guide.tour.path")}</div>
          <div className="grid grid-cols-3 gap-1.5">
            {steps.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onJump(i)}
                aria-current={i === step ? "step" : undefined}
                className={cn(
                  "flex min-h-8 items-center justify-center gap-1 rounded-lg px-1.5 py-1 text-center font-label-sm text-label-sm leading-tight transition-colors",
                  i === step
                    ? "bg-primary-container text-white font-bold"
                    : "bg-white text-on-surface-variant ring-1 ring-outline-variant/60 hover:bg-secondary/5",
                )}
              >
                {i < step && <span className="material-symbols-outlined text-[14px] text-primary">check</span>}
                <span>
                  {i + 1}. {t(s.short)}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            ref={nextBtn}
            type="button"
            onClick={onNext}
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[10px] bg-primary-container px-5 font-bold text-white shadow-md hover:bg-[#249f85]"
          >
            {last ? t("guide.tour.finish") : t("guide.tour.next")}
            <span className="material-symbols-outlined text-[18px] rtl:rotate-180">{last ? "check" : "arrow_forward"}</span>
          </button>
          <button
            type="button"
            onClick={onPrev}
            disabled={step === 0}
            className="inline-flex h-10 items-center justify-center rounded-[10px] bg-white px-4 font-bold text-secondary ring-1 ring-outline-variant hover:bg-secondary/5 disabled:pointer-events-none disabled:opacity-40"
          >
            {t("guide.tour.prev")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ms-auto rounded-[10px] px-2 py-2 font-label-md text-label-md text-on-surface-variant hover:bg-surface-container"
          >
            {t("guide.tour.skip")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
