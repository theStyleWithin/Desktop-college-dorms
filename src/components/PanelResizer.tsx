import { useEffect, useRef, useState } from "react";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The wall between a side panel and the middle: press and hold it with the left mouse button and drag to make the panel wider or
 * narrower. Double-click puts it back; the arrow keys nudge it. `side` is which panel it belongs to; the width is measured from
 * that edge of the window.
 */
export default function PanelResizer({ side, width, min, max, def, onResize, onCommit, label }: {
  side: "left" | "right";
  width: number;
  min: number;
  /** the widest it may be right now (the middle must keep room) */
  max: number;
  def: number;
  onResize: (w: number) => void;
  /** called when the drag ends (to remember the width) */
  onCommit: (w: number) => void;
  label: string;
}) {
  const [drag, setDrag] = useState(false);
  const el = useRef<HTMLDivElement>(null);
  const live = useRef(width);
  live.current = width;
  const limits = useRef({ min, max });
  limits.current = { min, max };

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const box = el.current?.parentElement?.getBoundingClientRect();
      if (!box) return;
      const w = side === "left" ? e.clientX - box.left : box.right - e.clientX;
      const n = Math.round(clamp(w, limits.current.min, Math.max(limits.current.min, limits.current.max)));
      live.current = n;
      onResize(n);
    };
    const up = () => { setDrag(false); onCommit(live.current); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    document.body.classList.add("resizing");
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.classList.remove("resizing");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, side]);

  const set = (w: number) => { const n = Math.round(clamp(w, min, Math.max(min, max))); onResize(n); onCommit(n); };
  return (
    <div ref={el} className={`resizer ${side}${drag ? " drag" : ""}`} role="separator" aria-orientation="vertical" aria-label={label}
      aria-valuenow={width} aria-valuemin={min} aria-valuemax={max} tabIndex={0} title="Drag to resize · double-click to reset"
      onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); setDrag(true); }}
      onDoubleClick={() => set(def)}
      onKeyDown={(e) => {
        const dir = side === "left" ? 1 : -1;
        if (e.key === "ArrowLeft") { e.preventDefault(); set(width - 16 * dir); }
        else if (e.key === "ArrowRight") { e.preventDefault(); set(width + 16 * dir); }
        else if (e.key === "Home") { e.preventDefault(); set(def); }
      }} />
  );
}
