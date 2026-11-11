import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// ---- toasts -------------------------------------------------------------
type ToastKind = "info" | "ok" | "err";
const ToastCtx = createContext<(msg: string, kind?: ToastKind) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string; kind: ToastKind }[]>([]);
  const push = useCallback((msg: string, kind: ToastKind = "info") => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, msg, kind }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), kind === "err" ? 9000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---- modal --------------------------------------------------------------
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  // Rendered on <body>, not where it was opened from: inside a <label>, the browser re-sends every click to the
  // label's first control, which used to close a window the instant it opened.
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-label={title}>
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 className="grow">{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ---- kebab menu ---------------------------------------------------------
export function Kebab({ items }: { items: { label: string; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div className="kebab" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className="iconbtn" aria-label="More" onClick={() => setOpen((o) => !o)}>⋮</button>
      {open && (
        <div className="menu">
          {items.map((i) => (
            <button key={i.label} className={i.danger ? "danger" : ""} onClick={() => { setOpen(false); i.onClick(); }}>
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- tag input ----------------------------------------------------------
export function TagInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState("");
  const add = (raw: string) => {
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) onChange([...value, ...parts.filter((p) => !value.includes(p))]);
    setText("");
  };
  return (
    <div>
      <input
        type="text"
        value={text}
        placeholder={placeholder ?? "Type a tag and press Enter"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(text); }
          else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => text && add(text)}
      />
      {value.length > 0 && (
        <div className="chips" style={{ marginTop: 8 }}>
          {value.map((t) => (
            <span className="chip" key={t}>{t}<span className="x" onClick={() => onChange(value.filter((v) => v !== t))}>✕</span></span>
          ))}
        </div>
      )}
    </div>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="15" fill="#2d2552" />
      <rect x="19" y="20" width="26" height="30" rx="2" fill="#ffd078" stroke="#1d163a" strokeWidth="3" />
      <path d="M32 20v30M19 35h26" stroke="#1d163a" strokeWidth="2.5" />
      <path d="M6 12q13 9 26 0t26 0" fill="none" stroke="#150f2c" strokeWidth="1.5" />
      {["#ff788c", "#ffd36e", "#82dcff", "#be96ff", "#8cf0aa"].map((c, i) => (
        <circle key={c} cx={9 + i * 11.5} cy={i % 2 ? 14.5 : 12} r="2.6" fill={c} />
      ))}
    </svg>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): [T | undefined, () => void, boolean] {
  const [v, setV] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn().then((r) => alive && (setV(r), setLoading(false))).catch(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [...deps, tick]);
  return [v, () => setTick((t) => t + 1), loading];
}
