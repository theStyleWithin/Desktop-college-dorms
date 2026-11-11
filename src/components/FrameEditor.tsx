import { useEffect, useRef, useState } from "react";
import { DEFAULT_FRAME, type Frame } from "../api";
import { frameStyle } from "./Art";
import { Modal } from "./ui";

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const isDefault = (f: Frame) => Math.abs(f.x - 0.5) < 1e-3 && Math.abs(f.y - 0.5) < 1e-3 && Math.abs(f.zoom - 1) < 1e-3;

/**
 * Move and zoom a picture until the face is just right. The big box is the card's shape: drag the picture inside it,
 * scroll or use the slider to zoom. The small boxes show how the same framing looks as a round avatar and as a wide
 * banner, so nothing important is cut off anywhere.
 */
export default function FrameEditor({ src, title = "Position the picture", initial, onSave, onClose }: {
  src: string; title?: string; initial?: Frame | null; onSave: (f: Frame | null) => void; onClose: () => void;
}) {
  const [f, setF] = useState<Frame>(initial ?? DEFAULT_FRAME);
  const fr = useRef(f); fr.current = f;
  const box = useRef<HTMLDivElement>(null);
  const nat = useRef<{ w: number; h: number } | null>(null);
  const [ready, setReady] = useState(false);

  // how far (in the picture's own pixels) the focus point can travel across the box, per axis
  const range = (axis: "x" | "y", z: number) => {
    const el = box.current, n = nat.current;
    if (!el || !n) return 0;
    const W = el.clientWidth, H = el.clientHeight;
    const s = Math.max(W / n.w, H / n.h);
    const size = axis === "x" ? W : H;
    const over = axis === "x" ? n.w * s - W : n.h * s - H;
    return size * (1 - 1 / z) + Math.max(0, over);
  };

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, f: { ...fr.current } };
    const move = (m: PointerEvent) => {
      const z = start.f.zoom, rx = range("x", z), ry = range("y", z);
      setF({
        zoom: z,
        x: rx > 0.5 ? clamp(start.f.x - (m.clientX - start.x) / z / rx, 0, 1) : start.f.x,
        y: ry > 0.5 ? clamp(start.f.y - (m.clientY - start.y) / z / ry, 0, 1) : start.f.y,
      });
    };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  };
  const zoom = (z: number) => setF((x) => ({ ...x, zoom: clamp(z, 1, 4) }));
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => { e.preventDefault(); setF((x) => ({ ...x, zoom: clamp(x.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), 1, 4) })); };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [ready]);
  const nudge = (dx: number, dy: number) => setF((x) => ({ ...x, x: clamp(x.x + dx, 0, 1), y: clamp(x.y + dy, 0, 1) }));

  const st = frameStyle(f);
  return (
    <Modal title={title} onClose={onClose} wide>
      <p className="sub" style={{ marginBottom: 10 }}>Drag the picture to move it, scroll or use the slider to zoom. Line the face up in the big box.</p>
      <div className="frame-ed">
        <div className="frame-main" ref={box} onPointerDown={down} data-testid="frame-main" role="img" aria-label="Drag to position the picture">
          <img src={src} alt="" draggable={false} style={st} onLoad={(e) => { nat.current = { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }; setReady(true); }} />
          <span className="frame-hint">drag to move · scroll to zoom</span>
        </div>
        <div className="frame-side">
          <div className="hint">Library card</div>
          <div className="frame-prev card"><img src={src} alt="" draggable={false} style={st} /></div>
          <div className="hint">Round avatar</div>
          <div className="frame-prev round"><img src={src} alt="" draggable={false} style={st} /></div>
          <div className="hint">Wide banner</div>
          <div className="frame-prev wide"><img src={src} alt="" draggable={false} style={st} /></div>
        </div>
      </div>
      <div className="row" style={{ margin: "12px 0", gap: 12 }}>
        <span aria-hidden>🔍</span>
        <input type="range" min={1} max={4} step={0.02} value={f.zoom} onChange={(e) => zoom(Number(e.target.value))} aria-label="Zoom" style={{ flex: 1 }} />
        <span className="tok" style={{ width: 44 }}>{f.zoom.toFixed(2)}×</span>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn sm" onClick={() => nudge(-0.03, 0)} aria-label="Move picture right">→</button>
          <button className="btn sm" onClick={() => nudge(0.03, 0)} aria-label="Move picture left">←</button>
          <button className="btn sm" onClick={() => nudge(0, -0.03)} aria-label="Move picture down">↓</button>
          <button className="btn sm" onClick={() => nudge(0, 0.03)} aria-label="Move picture up">↑</button>
        </div>
        <button className="btn sm" onClick={() => setF(DEFAULT_FRAME)}>Reset</button>
      </div>
      <div className="row">
        <button className="btn primary" onClick={() => onSave(isDefault(f) ? null : { x: +f.x.toFixed(4), y: +f.y.toFixed(4), zoom: +f.zoom.toFixed(3) })}>Save</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
