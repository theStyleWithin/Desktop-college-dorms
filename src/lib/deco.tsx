import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { api, type CharDeco } from "../api";
import DecoCore from "./decoCore";

/** The pictures behind the decorations are drawn (and animated) in decoCore.js and handed to the page as CSS, once: a moving set and a still set. */
let injected = false;
export function ensureDecoArt() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  let css = "";
  for (const an of [true, false]) {
    const art = DecoCore.buildArt(an), p = an ? 'html:not([data-deco-anim="off"])' : 'html[data-deco-anim="off"]';
    for (const id of Object.keys(art.wreath)) css += `${p} .dw[data-wreath="${id}"]::after{background-image:${DecoCore.uri(art.wreath[id])}}\n`;
    for (const id of Object.keys(art.plate)) css += `${p} [data-plate="${id}"]::before{background:${DecoCore.uri(art.plate[id])} center/cover no-repeat;animation:none}\n`;
    for (const id of Object.keys(art.bg)) css += `${p} .deco-bg[data-bg="${id}"]{background-image:${DecoCore.uri(art.bg[id])}}\n`;
  }
  const el = document.createElement("style"); el.id = "deco-art"; el.textContent = css; document.head.append(el);
}

/** Things move only if the user wants them to and the device isn't asking for less motion. */
export function setDecoMotion(animate: boolean) {
  const calm = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.documentElement.dataset.decoAnim = animate && !calm ? "on" : "off";
}

/** How the characters are dressed (shared by every part of the app that shows a character). */
let charMap = new Map<string, CharDeco>();
let version = 0, loaded = false;
const subs = new Set<() => void>();
const emit = () => { version++; subs.forEach((f) => f()); };
export async function reloadCharDeco() {
  try { charMap = new Map((await api.listCharDeco()).map((d) => [d.character_id, d])); loaded = true; emit(); } catch { /* shown undressed */ }
}
export function putCharDeco(id: string, d: CharDeco | null) { charMap = new Map(charMap); if (d) charMap.set(id, d); else charMap.delete(id); emit(); }
export function useCharDeco(): Map<string, CharDeco> {
  useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => version);
  useEffect(() => { if (!loaded) void reloadCharDeco(); }, []);
  return charMap;
}

/** An avatar with a wreath around it (the wreath is drawn over the edge of the picture). */
export function Wreathed({ wreath, size, children }: { wreath?: string | null; size?: "sm" | "xs"; children: ReactNode }) {
  if (!wreath) return <>{children}</>;
  ensureDecoArt();
  return <span className={`dw${size ? " " + size : ""}`} data-wreath={wreath}>{children}</span>;
}

/** The attributes that put a nameplate behind a row (together with the `plated` class). */
export function plateProps(plate: string | undefined, animate = true): { className: string; "data-plate"?: string; "data-anim"?: string } {
  if (!plate || plate === "none" || !DecoCore.plateOk(plate)) return { className: "" };
  ensureDecoArt();
  return { className: "plated", "data-plate": plate, "data-anim": animate ? "on" : "off" };
}

/** The little name tag (2 to 4 letters, a colour and maybe a symbol) shown beside a name. */
export function TagChip({ tag, color, glyph }: { tag?: string; color?: string; glyph?: string }) {
  // what is typed is cleaned here (letters and numbers only, in capitals, 2 to 4 of them), not in the box while it is being typed in
  const t = tag && DecoCore.tagOk(tag) ? DecoCore.cleanTag(tag) : "";
  if (!t) return null;
  return <span className="srv-tag" style={{ "--tag": color || "#5865f2" } as React.CSSProperties} title="Name tag">{glyph ? <i aria-hidden="true">{glyph}</i> : null}{t}</span>;
}

/** A moving profile background (a strip of scenery behind a name and a picture). */
export function DecoBg({ bg, height = 76, children }: { bg: string; height?: number; children?: ReactNode }) {
  if (bg) ensureDecoArt();
  return <div className="dbanner" style={{ height }}>{bg ? <span className="deco-bg" data-bg={bg} /> : null}{children}</div>;
}
