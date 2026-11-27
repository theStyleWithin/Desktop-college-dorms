/**
 * Makes scroll bars easier to find and grab with a mouse: while the pointer is within a short distance of the edge where a scrolling area's bar is,
 * that bar's handle thickens and brightens (the `sb-near` class; see the style sheet), so it is clear where to go. The strip itself is always wide, and
 * nothing moves when the handle changes, so the page never jumps. Touch screens have no pointer to track, so nothing is done there.
 */
const NEAR = 64;   // how close (in pixels) counts as near: about two thirds of an inch on a usual screen

/** The scrolling area under the pointer whose bar the pointer is near (a vertical bar at its right edge, or a horizontal one at its bottom edge). */
export function scrollAreaNear(x: number, y: number, doc: Document = document): HTMLElement | null {
  let el = doc.elementFromPoint(x, y) as HTMLElement | null;
  while (el) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const v = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1 && x >= r.right - NEAR;
    const h = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1 && y >= r.bottom - NEAR;
    if (v || h) return el;
    el = el.parentElement;
  }
  return null;
}

let current: HTMLElement | null = null;
const mark = (el: HTMLElement | null) => {
  if (el === current) return;
  current?.classList.remove("sb-near");
  current = el;
  current?.classList.add("sb-near");
};

/** Starts watching the pointer (once). */
export function startScrollNear(): void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia("(hover: none)").matches) return;
  let frame = 0, x = 0, y = 0;
  window.addEventListener("mousemove", (e) => {
    x = e.clientX; y = e.clientY;
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; mark(scrollAreaNear(x, y)); });
  }, { passive: true });
  document.addEventListener("mouseleave", () => mark(null));
  window.addEventListener("blur", () => mark(null));
}
