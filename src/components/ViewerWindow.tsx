import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Mode = "window" | "theatre" | "full";
interface Box { x: number; y: number; w: number; h: number }

const KEY = "dorms.viewer.box";
const MIN_W = 420, MIN_H = 320;
const EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

const clampBox = (b: Box): Box => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(Math.max(b.w, Math.min(MIN_W, vw)), vw), h = Math.min(Math.max(b.h, Math.min(MIN_H, vh)), vh);
  return { w, h, x: Math.min(Math.max(b.x, 0), vw - w), y: Math.min(Math.max(b.y, 0), vh - h) };
};
const defaultBox = (): Box => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(1100, vw * 0.9), h = Math.min(780, vh * 0.86);
  return { w, h, x: (vw - w) / 2, y: (vh - h) / 2 };
};
const loadBox = (): Box => {
  try {
    const b = JSON.parse(localStorage.getItem(KEY) || "null");
    if (b && [b.x, b.y, b.w, b.h].every(Number.isFinite)) return clampBox(b);
  } catch { /* fall through */ }
  return defaultBox();
};

/** The real OS-level fullscreen where the shell allows it (Tauri window, then the browser API); the CSS layout is the fallback. */
async function osFullscreen(on: boolean) {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFullscreen(on);
    return;
  } catch { /* not in the app, or not permitted */ }
  try {
    if (on) await document.documentElement.requestFullscreen?.();
    else if (document.fullscreenElement) await document.exitFullscreen();
  } catch { /* the CSS layout still covers the window */ }
}

/**
 * The big 3D viewer as its own window: drag the title bar to move it, pull any edge or corner to resize it, or switch to
 * theatre mode (wide, dimmed room around it) or full screen. Escape steps back one level (full screen, theatre, then close).
 */
export default function ViewerWindow({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const [mode, setMode] = useState<Mode>("window");
  const [box, setBox] = useState<Box>(loadBox);
  const boxRef = useRef(box); boxRef.current = box;
  const modeRef = useRef(mode); modeRef.current = mode;

  const persist = useCallback((b: Box) => { try { localStorage.setItem(KEY, JSON.stringify(b)); } catch { /* ignore */ } }, []);
  const setFull = useCallback((on: boolean) => { setMode(on ? "full" : "window"); void osFullscreen(on); }, []);
  const toggle = useCallback((m: Mode) => {
    const cur = modeRef.current;
    if (cur === "full") void osFullscreen(false);
    if (m === "full") { setMode(cur === "full" ? "window" : "full"); if (cur !== "full") void osFullscreen(true); }
    else setMode(cur === m ? "window" : m);
  }, []);

  // leave OS fullscreen when this window closes
  useEffect(() => () => { if (modeRef.current === "full") void osFullscreen(false); }, []);

  // the user can also leave fullscreen with the browser's own key: follow it
  useEffect(() => {
    const f = () => { if (!document.fullscreenElement && modeRef.current === "full" && !("__TAURI_INTERNALS__" in window)) setMode("window"); };
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        if (modeRef.current === "full") setFull(false);
        else if (modeRef.current === "theatre") setMode("window");
        else onClose();
      } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "f" || e.key === "F") { e.preventDefault(); toggle("full"); }
        else if (e.key === "t" || e.key === "T") { e.preventDefault(); toggle("theatre"); }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, setFull, toggle]);

  // keep the window on screen when the app window shrinks
  useEffect(() => {
    const r = () => setBox((b) => clampBox(b));
    window.addEventListener("resize", r);
    return () => window.removeEventListener("resize", r);
  }, []);

  const drag = (e: React.PointerEvent, edge: string) => {
    if (mode !== "window" || e.button !== 0) return;
    e.preventDefault();
    const start = { ...boxRef.current }, sx = e.clientX, sy = e.clientY;
    const vw = window.innerWidth, vh = window.innerHeight;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      const dx = m.clientX - sx, dy = m.clientY - sy;
      let { x, y, w, h } = start;
      if (edge === "move") { x = Math.min(Math.max(start.x + dx, -start.w + 120), vw - 120); y = Math.min(Math.max(start.y + dy, 0), vh - 40); }
      else {
        if (edge.includes("e")) w = Math.min(Math.max(start.w + dx, MIN_W), vw - start.x);
        if (edge.includes("s")) h = Math.min(Math.max(start.h + dy, MIN_H), vh - start.y);
        if (edge.includes("w")) { const nw = Math.min(Math.max(start.w - dx, MIN_W), start.x + start.w); x = start.x + start.w - nw; w = nw; }
        if (edge.includes("n")) { const nh = Math.min(Math.max(start.h - dy, MIN_H), start.y + start.h); y = start.y + start.h - nh; h = nh; }
      }
      setBox({ x, y, w, h });
    };
    const up = () => {
      target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", up); target.removeEventListener("pointercancel", up);
      persist(boxRef.current);
    };
    target.addEventListener("pointermove", move); target.addEventListener("pointerup", up); target.addEventListener("pointercancel", up);
  };

  const style = mode === "window" ? { left: box.x, top: box.y, width: box.w, height: box.h } : undefined;
  return createPortal(
    <div className={`vw-back vw-${mode}`} onMouseDown={(e) => { if (e.target === e.currentTarget && mode === "window") onClose(); }}>
      <div className="vw" role="dialog" aria-label={title} data-mode={mode} style={style}>
        <div className="vw-bar" onPointerDown={(e) => { if ((e.target as HTMLElement).closest("button")) return; drag(e, "move"); }} onDoubleClick={() => toggle("theatre")}>
          <h2 className="grow">{title}</h2>
          <button className="btn ghost sm" aria-label="Theatre mode" aria-pressed={mode === "theatre"} title="Theatre mode (T)" onClick={() => toggle("theatre")}>▭</button>
          <button className="btn ghost sm" aria-label="Full screen" aria-pressed={mode === "full"} title="Full screen (F)" onClick={() => toggle("full")}>{mode === "full" ? "🗗" : "⛶"}</button>
          <button className="btn ghost sm" aria-label="Close" title="Close (Esc)" onClick={onClose}>✕</button>
        </div>
        <div className="vw-body">{children}</div>
        {mode === "window" && EDGES.map((e) => <div key={e} className={`vw-h vw-h-${e}`} data-edge={e} onPointerDown={(ev) => drag(ev, e)} />)}
      </div>
    </div>,
    document.body,
  );
}
