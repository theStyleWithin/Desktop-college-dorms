import { useState } from "react";
import PanelResizer from "../components/PanelResizer";

const MIN = 200, MAX = 640;
const read = (key: string, def: number) => { try { const v = Number(localStorage.getItem(key)); return v >= MIN && v <= MAX ? v : def; } catch { return def; } };

/**
 * A list panel (Lorebooks, Notes) whose width the person can change: hold its right edge and drag (double-click puts it back).
 * `style` goes on the container that holds the panel, `resizer` inside the panel (which must be position: relative).
 */
export function useListWidth(key: string, def = 300, label = "Resize the list") {
  const [w, setW] = useState(() => read(key, def));
  const max = Math.min(MAX, Math.max(MIN, (typeof window === "undefined" ? 1200 : window.innerWidth) * 0.6));
  const resizer = (
    <PanelResizer side="left" width={w} min={MIN} max={max} def={def} label={label} onResize={setW}
      onCommit={(n) => { try { localStorage.setItem(key, String(n)); } catch { /* storage unavailable */ } }} />
  );
  return { style: { "--list-w": `${w}px` } as React.CSSProperties, resizer };
}
