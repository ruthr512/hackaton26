import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

function Icon({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span className={`material-symbols-outlined ${className}`} aria-hidden>
      {name}
    </span>
  );
}

export type SelectOption = { value: string; label: string };

type Props = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  icon?: string;
};

type Pos = { top?: number; bottom?: number; left?: number; right?: number; minWidth: number };

const MENU_MAX_H = 264;
const MENU_MIN_W = 208;

/* Styled listbox that matches the language picker. The menu is portaled with fixed positioning so
   it is not clipped by scrolling table wrappers; it closes when anything outside it scrolls. */
export function Select({ value, options, onChange, placeholder, ariaLabel, icon }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<Pos | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  const place = () => {
    const el = button.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const rtl = getComputedStyle(el).direction === "rtl";
    const minWidth = Math.max(r.width, MENU_MIN_W);
    const below = window.innerHeight - r.bottom;
    const next: Pos = { minWidth };
    if (below < MENU_MAX_H + 16 && r.top > below) next.bottom = window.innerHeight - r.top + 6;
    else next.top = r.bottom + 6;
    if (rtl) next.right = Math.max(8, Math.min(window.innerWidth - r.right, window.innerWidth - minWidth - 8));
    else next.left = Math.max(8, Math.min(r.left, window.innerWidth - minWidth - 8));
    setPos(next);
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const toggle = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen((o) => !o);
  };
  const pick = (o: SelectOption) => {
    setOpen(false);
    button.current?.focus();
    if (o.value !== value) onChange(o.value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        toggle();
      }
      return;
    }
    const n = options.length;
    if (e.key === "ArrowDown") setActive((i) => (i + 1) % n);
    else if (e.key === "ArrowUp") setActive((i) => (i - 1 + n) % n);
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(n - 1);
    else if (e.key === "Enter" || e.key === " ") {
      if (options[active]) pick(options[active]);
    } else if (e.key === "Tab") return setOpen(false);
    else return;
    e.preventDefault();
  };

  return (
    <div className="relative inline-block" onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={toggle}
        className={`h-9 min-w-[150px] flex items-center gap-2 rounded-[10px] bg-white border ps-2.5 pe-2 font-body-sm text-body-sm text-navy transition-colors ${
          open ? "border-primary/50 bg-primary-container/10" : "border-[rgba(43,41,109,0.12)] hover:bg-primary-container/10"
        }`}
      >
        {icon && <Icon name={icon} className="text-[18px] text-outline" />}
        <span className={`flex-1 truncate text-start ${current ? "" : "text-on-surface-variant"}`}>
          {current ? current.label : placeholder}
        </span>
        <Icon
          name="expand_more"
          className={`text-[18px] text-outline transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menu}
            style={pos}
            onKeyDown={onKeyDown}
            className="fixed z-[100] p-1.5 rounded-2xl bg-surface-container-lowest border border-secondary/10 shadow-[0_16px_40px_-8px_rgba(43,41,109,0.18)]"
          >
            <ul role="listbox" aria-label={ariaLabel} className="flex flex-col gap-0.5 overflow-y-auto" style={{ maxHeight: MENU_MAX_H }}>
              {options.map((o, i) => {
                const selected = o.value === value;
                return (
                  <li key={o.value} role="option" aria-selected={selected}>
                    <button
                      type="button"
                      data-i={i}
                      onClick={() => pick(o)}
                      onMouseEnter={() => setActive(i)}
                      className={`w-full h-11 flex items-center gap-3 rounded-[10px] px-2.5 text-start transition-colors ${
                        selected ? "bg-primary-container/15 text-secondary font-bold" : "text-on-surface"
                      } ${i === active && !selected ? "bg-primary-container/10" : ""}`}
                    >
                      <span
                        dir="auto"
                        className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center font-label-md text-label-md ${
                          selected ? "bg-primary-container text-on-primary" : "bg-primary-container/15 text-primary"
                        }`}
                      >
                        {Array.from(o.label.trim())[0]?.toUpperCase()}
                      </span>
                      <span className="flex-1 truncate font-body-md text-body-md">{o.label}</span>
                      {selected && <Icon name="check" className="text-[20px] text-primary" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}
