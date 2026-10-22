import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

function Icon({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span className={`material-symbols-outlined ${className}`} aria-hidden>
      {name}
    </span>
  );
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  /** A suggestion was chosen (the text is free: typing something that is not in the list stays possible). */
  onPick: (value: string) => void;
};

type Pos = { top?: number; bottom?: number; left: number; width: number };

const MENU_MAX_H = 264;

/** Splits `text` around the first case-insensitive occurrence of `q`, so the match can be shown in bold. */
function highlight(text: string, q: string) {
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <strong className="font-bold text-secondary">{text.slice(at, at + q.length)}</strong>
      {text.slice(at + q.length)}
    </>
  );
}

/* A text input with a suggestion menu in the site's own style (same look as the language picker and Select).
   The menu is portaled with fixed positioning so scrolling wrappers do not clip it. */
export const SuggestInput = forwardRef<HTMLInputElement, Props>(function SuggestInput(
  { value, onChange, options, onPick, onKeyDown, onFocus, onBlur, ...rest },
  ref,
) {
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => input.current as HTMLInputElement);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<Pos | null>(null);

  // Showing the whole list when the text is empty or already a complete name, otherwise what contains the text.
  const q = value.trim();
  const exact = options.includes(q);
  const shown = !q || exact ? options : options.filter((o) => o.toLowerCase().includes(q.toLowerCase()));
  const visible = open && shown.length > 0;

  const place = () => {
    const el = input.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const next: Pos = { left: r.left, width: r.width };
    if (below < Math.min(MENU_MAX_H, shown.length * 44 + 12) + 16 && r.top > below) next.bottom = window.innerHeight - r.top + 6;
    else next.top = r.bottom + 6;
    setPos(next);
  };

  useLayoutEffect(() => {
    if (visible) place();
  }, [visible, shown.length]);

  useEffect(() => {
    if (!visible) return;
    const onScroll = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    const close = () => setOpen(false);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [visible]);

  useEffect(() => {
    if (visible && active >= 0) menu.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [visible, active]);

  const pick = (o: string) => {
    setOpen(false);
    setActive(-1);
    onPick(o);
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = shown.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!n) return;
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(Math.max(0, shown.indexOf(q)));
      } else {
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i < 0 ? (step > 0 ? 0 : n - 1) : (i + step + n) % n));
      }
      return;
    }
    if (e.key === "Enter" && visible && active >= 0 && shown[active] !== undefined) {
      e.preventDefault();
      pick(shown[active]);
      return;
    }
    if (e.key === "Escape") setOpen(false);
    onKeyDown?.(e);
  };

  return (
    <>
      <input
        {...rest}
        ref={input}
        value={value}
        role="combobox"
        aria-expanded={visible}
        aria-autocomplete="list"
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onFocus={(e) => {
          setOpen(true);
          setActive(-1);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setOpen(false);
          onBlur?.(e);
        }}
        onKeyDown={handleKey}
      />
      {visible &&
        pos &&
        createPortal(
          <div
            ref={menu}
            style={pos}
            // keep the focus in the input: a click on the menu must not blur (and so save) the half-typed text
            onMouseDown={(e) => e.preventDefault()}
            className="fixed z-[100] p-1.5 rounded-2xl bg-surface-container-lowest border border-secondary/10 shadow-[0_16px_40px_-8px_rgba(43,41,109,0.18)]"
          >
            <ul role="listbox" className="flex flex-col gap-0.5 overflow-y-auto" style={{ maxHeight: MENU_MAX_H }}>
              {shown.map((o, i) => {
                const selected = o === q;
                return (
                  <li key={o} role="option" aria-selected={selected}>
                    <button
                      type="button"
                      tabIndex={-1}
                      data-i={i}
                      title={o}
                      onClick={() => pick(o)}
                      onMouseEnter={() => setActive(i)}
                      className={`w-full min-h-[40px] py-1.5 flex items-center gap-3 rounded-[10px] px-2.5 text-start transition-colors ${
                        selected ? "bg-primary-container/15 text-secondary font-bold" : "text-on-surface"
                      } ${i === active && !selected ? "bg-primary-container/10" : ""}`}
                    >
                      <span
                        className={`w-7 h-7 shrink-0 rounded-full flex items-center justify-center ${
                          selected ? "bg-primary-container text-on-primary" : "bg-primary-container/15 text-primary"
                        }`}
                      >
                        <Icon name="domain" className="text-[16px]" />
                      </span>
                      <span dir="auto" className="flex-1 truncate font-body-md text-body-md">
                        {selected ? o : highlight(o, q)}
                      </span>
                      {selected && <Icon name="check" className="text-[20px] text-primary" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
});
