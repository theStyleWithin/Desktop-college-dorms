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
