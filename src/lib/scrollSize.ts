import { useEffect, useState } from "react";
import { sdel, sget, sset } from "./scoped";

/**
 * How thick scroll bars are: `wide` (the default: a wider strip that is easier to grab) or `slim` (the thinner size they used to be). Either way the bar's handle
 * still thickens and brightens when the pointer is near it. It belongs to the profile (or the guest space) that chose it, kept on this device (see `lib/scoped`).
 */
export type ScrollSize = "wide" | "slim";
const KEY = "dorms.scrollbar.size";

export function getScrollSize(): ScrollSize {
  return sget(KEY) === "slim" ? "slim" : "wide";
}

/** Put the saved size into the page (call once at start, and whenever it changes). */
export function applyScrollSize(v: ScrollSize = getScrollSize()) {
  document.documentElement.dataset.scrollbar = v;
}

/**
 * Some web views don't redraw a scroll bar that is already on screen when the style that sizes it changes (the bar keeps its old width until something else
 * makes it redraw). Briefly hiding and showing each scrolling area's overflow makes it redraw right away. Done only when the person changes the setting.
 */
export function refreshScrollbars() {
  const hit: [HTMLElement, string, string][] = [];
  document.querySelectorAll<HTMLElement>("*").forEach((el) => {
    const cs = getComputedStyle(el);
    if (/(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflowX)) hit.push([el, el.style.overflowX, el.style.overflowY]);
  });
  for (const [el] of hit) { el.style.overflowX = "hidden"; el.style.overflowY = "hidden"; }
  void document.body.offsetWidth;   // let the page lay out with the bars gone
  for (const [el, x, y] of hit) { el.style.overflowX = x; el.style.overflowY = y; }
}

export function setScrollSize(v: ScrollSize) {
  try { if (v === "wide") sdel(KEY); else sset(KEY, v); } catch { /* storage unavailable: it still applies until the app is closed */ }
  applyScrollSize(v);
  refreshScrollbars();
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
