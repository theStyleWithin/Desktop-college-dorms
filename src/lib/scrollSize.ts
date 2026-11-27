import { useEffect, useState } from "react";

/**
 * How thick scroll bars are: `wide` (the default: a wider strip that is easier to grab) or `slim` (the thinner size they used to be). Either way the bar's handle
 * still thickens and brightens when the pointer is near it. It is a preference of this device, so it is kept here and not in the profile.
 */
export type ScrollSize = "wide" | "slim";
const KEY = "dorms.scrollbar.size";

export function getScrollSize(): ScrollSize {
  try { return localStorage.getItem(KEY) === "slim" ? "slim" : "wide"; } catch { return "wide"; }
}

/** Put the saved size into the page (call once at start, and whenever it changes). */
export function applyScrollSize(v: ScrollSize = getScrollSize()) {
  document.documentElement.dataset.scrollbar = v;
}

export function setScrollSize(v: ScrollSize) {
  try { if (v === "wide") localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch { /* storage unavailable: it still applies until the app is closed */ }
  applyScrollSize(v);
  window.dispatchEvent(new CustomEvent("dorms-scroll-size", { detail: v }));
}

/** The current size and a way to change it; every control that shows it stays in step. */
export function useScrollSize(): [ScrollSize, (v: ScrollSize) => void] {
  const [v, setV] = useState(getScrollSize);
  useEffect(() => {
    const f = (e: Event) => setV((e as CustomEvent<ScrollSize>).detail);
    window.addEventListener("dorms-scroll-size", f);
    return () => window.removeEventListener("dorms-scroll-size", f);
  }, []);
  return [v, setScrollSize];
}
