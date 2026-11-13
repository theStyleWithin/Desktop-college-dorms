import { useEffect, useState } from "react";

/** How big the text is in chats: a multiplier (1 = normal). It is a preference of this device, so it is kept here and not in the profile. */
const KEY = "dorms.chat.textScale";
export const TEXT_SCALE_MIN = 0.8;
export const TEXT_SCALE_MAX = 2;

const clamp = (v: number) => (Number.isFinite(v) ? Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, Math.round(v * 20) / 20)) : 1);

export function getTextScale(): number {
  try { const v = Number(localStorage.getItem(KEY)); return v ? clamp(v) : 1; } catch { return 1; }
}

/** Put the saved size into the page (call once at start, and whenever it changes). */
export function applyTextScale(v = getTextScale()) {
  document.documentElement.style.setProperty("--chat-scale", String(v));
}

export function setTextScale(v: number) {
  const n = clamp(v);
  try { if (n === 1) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(n)); } catch { /* storage unavailable: it still applies until the app is closed */ }
  applyTextScale(n);
  window.dispatchEvent(new CustomEvent("dorms-text-scale", { detail: n }));
}

/** The current size and a way to change it; every control that shows it stays in step. */
export function useTextScale(): [number, (v: number) => void] {
  const [v, setV] = useState(getTextScale);
  useEffect(() => {
    const f = (e: Event) => setV((e as CustomEvent<number>).detail);
    window.addEventListener("dorms-text-scale", f);
    return () => window.removeEventListener("dorms-text-scale", f);
  }, []);
  return [v, setTextScale];
}

/**
 * Change the size while someone is reading: the text you were reading stays where it is on the screen (or, if you were at the newest
 * message, you stay at the newest message), instead of the page jumping as the lines get longer or shorter. Follows the change
 * for a moment, since the size eases in.
 */
export function setTextScaleAnchored(v: number) {
  const box = document.querySelector<HTMLElement>(".msgs");
  let ref: HTMLElement | null = null, off = 0;
  const atBottom = !!box && box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  if (box && !atBottom) {
    const top = box.getBoundingClientRect().top;
    for (const c of Array.from(box.children) as HTMLElement[]) {
      const r = c.getBoundingClientRect();
      if (r.bottom > top + 8) { ref = c; off = r.top - top; break; }
    }
  }
  setTextScale(v);
  if (!box) return;
  const t0 = performance.now();
  const step = () => {
    if (atBottom) box.scrollTop = box.scrollHeight;
    else if (ref && ref.isConnected) box.scrollTop += ref.getBoundingClientRect().top - box.getBoundingClientRect().top - off;
    if (performance.now() - t0 < 300) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
