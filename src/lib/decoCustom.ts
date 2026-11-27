import { useSyncExternalStore } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { api, type CustomDeco } from "../api";
import DecoCore from "./decoCore";
import Pk, { type PackItem, type PackKind } from "./decoPack";

/**
 * The person's own decorations: nameplates, profile backgrounds and avatar wreaths brought in from a file (a .asdeco pack, or a lone
 * SVG, picture or short video). Ported from Anti-Social, the same format. The art is only ever drawn as a picture (a CSS background),
 * and it is rebuilt from an allow-list on the way in (decoPack.js) and checked again every time it is loaded here.
 */
export interface OwnDeco {
  id: string; dkind: PackKind; name: string; blurb: string; author: string; license: string; pack: string;
  mode: "svg" | "image" | "sprite"; art: string; still: string; moves: boolean; src: string; cols: number; rows: number; frames: number; dur: number;
}

let own: OwnDeco[] = [];
let version = 0, paintSig = "";
const subs = new Set<() => void>();
const emit = () => { version++; subs.forEach((f) => f()); };
export function useCustomDeco(): OwnDeco[] {
  useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => version);
  return own;
}

const num = (v: unknown, lo: number, hi: number) => { const n = Math.round(Number(v)); return n >= lo && n <= hi ? n : 0; };
/** A stored record -> what the app uses, or null. Everything is checked again here, because a file imported with a profile could say anything. */
export function vet(r: Partial<CustomDeco> | null | undefined): OwnDeco | null {
  if (!r || !r.dkind || !Pk.KINDS[r.dkind] || !Pk.isId(r.did) || Pk.kindOfId(r.did) !== r.dkind || typeof r.art !== "string") return null;
  const mode = r.mode === "image" || r.mode === "sprite" ? r.mode : "svg";
  const o: OwnDeco = {
    id: r.did as string, dkind: r.dkind, name: Pk.tidy(r.name, 40) || "Mine", blurb: Pk.tidy(r.blurb, 100), author: Pk.tidy(r.author, 60), license: Pk.tidy(r.license, 60), pack: Pk.tidy(r.pack, 40),
    mode, art: "", still: "", moves: false, src: "", cols: 0, rows: 0, frames: 0, dur: 0,
  };
  if (mode === "svg") {
    const a = Pk.cleanSvg(r.art, o.dkind, { animate: true }); if (!a.ok) return null;
    const st = r.still ? Pk.cleanSvg(r.still, o.dkind, { animate: false }) : null;
    o.art = a.svg; o.moves = a.moves; o.still = st && st.ok ? st.svg : Pk.cleanSvg(r.art, o.dkind, { animate: false }).svg;
    return o;
  }
  const i = Pk.imageInfo(r.art); if (!i) return null;
  o.art = r.art;
  if (mode === "image") { o.moves = i.moves; o.still = r.still && Pk.imageInfo(r.still) ? r.still : ""; return o; }
  o.cols = num(r.cols, 1, 16); o.rows = num(r.rows, 1, 16); o.frames = num(r.frames, 1, o.cols * o.rows);
  o.dur = Math.min(12, Math.max(0.5, Number(r.dur) || 0)); o.moves = o.frames > 1;
  if (!o.cols || !o.rows || !o.frames || !o.dur) return null;
  o.src = typeof r.src === "string" && r.src.length < 5e6 ? r.src : "";
  return o;
}

const urlOf = (r: OwnDeco, text: string) => (r.mode === "svg" ? DecoCore.uri(text) : `url("${text}")`);
/** The CSS that draws one of them, moving and standing still (the page picks by data-deco-anim, like the built-in art). */
function cssFor(r: OwnDeco, an: boolean): string {
  const p = an ? 'html:not([data-deco-anim="off"])' : 'html[data-deco-anim="off"]';
  const sel = r.dkind === "wreath" ? `${p} .dw[data-wreath="${r.id}"]::after` : r.dkind === "plate" ? `${p} [data-plate="${r.id}"]::before` : `${p} .deco-bg[data-bg="${r.id}"]`;
  if (r.mode === "sprite") {
    const at = (k: number) => `${r.cols > 1 ? ((k % r.cols) / (r.cols - 1)) * 100 : 0}% ${r.rows > 1 ? (Math.floor(k / r.cols) / (r.rows - 1)) * 100 : 0}%`;
    const play = an && r.frames > 1;
    let kf = "";
    if (play) { for (let k = 0; k < r.frames; k++) kf += `${+((k / r.frames) * 100).toFixed(3)}%{background-position:${at(k)}}`; kf = `@keyframes dv_${r.id}{${kf}}\n`; }
    const decl = [`background-image:${urlOf(r, r.art)}`, `background-size:${r.cols * 100}% ${r.rows * 100}%`, "background-repeat:no-repeat", `background-position:${at(0)}`, play ? `animation:dv_${r.id} ${r.dur}s step-end infinite` : "animation:none"];
    return kf + `${sel}{${decl.join(";")}}\n`;
  }
  const url = urlOf(r, an ? r.art : r.still || r.art);
  if (r.dkind === "wreath") return `${sel}{background-image:${url}}\n`;
  return `${sel}{background:${url} center/cover no-repeat${r.dkind === "plate" ? ";animation:none" : ""}}\n`;
}
function paint() {
  const sig = own.map((r) => r.id + r.mode + r.art.length).join();
  if (sig === paintSig) return;
  paintSig = sig;
  let el = document.getElementById("deco-custom");
  if (!el) { el = document.createElement("style"); el.id = "deco-custom"; document.head.append(el); }
  el.textContent = own.map((r) => cssFor(r, true) + cssFor(r, false)).join("");
}

/** Loads the person's own decorations (on start, and whenever the profile changes) and makes them known to the pickers and the art. */
export async function reloadCustomDeco() {
  try { own = (await api.listCustomDeco()).map(vet).filter((x): x is OwnDeco => !!x); } catch { own = []; }
  DecoCore.setCustom("own", own);
  paint();
  emit();
}

/** Adds prepared items to the library; returns how many were kept. */
export async function saveCustom(items: PackItem[]): Promise<number> {
  const recs: CustomDeco[] = items.map((it) => ({
    did: it.id, dkind: it.kind, mode: it.mode === "video" ? "sprite" : (it.mode as CustomDeco["mode"]), name: it.name, blurb: it.blurb || "", art: it.art, still: it.still || "", moves: !!it.moves,
    author: it.author || "", license: it.license || "", pack: it.pack || "", cols: it.cols || 0, rows: it.rows || 0, frames: it.frames || 0, dur: it.dur || 0, src: it.mode === "sprite" ? it.src || "" : "",
  }));
  const kept = await api.saveCustomDeco(recs);
  await reloadCustomDeco();
  return kept.length;
}
export async function removeCustom(did: string) { await api.deleteCustomDeco(did); await reloadCustomDeco(); }

/** The whole library as one .asdeco pack, saved where the person chooses. Returns the path, or null if they changed their mind. */
export async function exportCustom(author: string): Promise<string | null> {
  const text = Pk.buildPack({ name: "My decorations", author, license: "" }, own.map((x) => ({ dkind: x.dkind, name: x.name, blurb: x.blurb, art: x.art, mode: x.mode, still: x.still, src: x.src })));
  const path = await save({ defaultPath: "my-decorations.asdeco", filters: [{ name: "Decoration pack", extensions: ["asdeco"] }] });
  if (!path) return null;
  await writeFile(path, new TextEncoder().encode(text));
  return path;
}

/* ---------- reading files ---------- */
const dataUrlOf = (f: Blob) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(new Error("read")); r.readAsDataURL(f); });
const blobOfUri = (uri: string) => { const m = /^data:([^;]+);base64,(.*)$/s.exec(uri)!, bin = atob(m[2]), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: m[1] }); };
const waitFor = (el: EventTarget, ev: string, ms: number, msg: string) => new Promise<void>((ok, no) => {
  const t = setTimeout(() => no(new Error(msg)), ms);
  el.addEventListener(ev, () => { clearTimeout(t); ok(); }, { once: true });
  el.addEventListener("error", () => { clearTimeout(t); no(new Error(msg)); }, { once: true });
});

/** The first picture of an animated image, as a PNG (shown when "Animate decorations" is off). */
async function firstFrame(uri: string): Promise<string> {
  const img = new Image(); img.src = uri; await waitFor(img, "load", 8000, "That picture would not open.");
  const k = Math.min(1, 960 / img.naturalWidth), cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(img.naturalWidth * k)); cv.height = Math.max(1, Math.round(img.naturalHeight * k));
  cv.getContext("2d")!.drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/png");
}

/** A short video clip -> one PNG holding its frames in a grid, played back by CSS (no video player is needed anywhere in the app). */
async function videoToSprite(uri: string, kind: PackKind, say?: ((t: string) => void) | null) {
  const K = Pk.KINDS[kind], cell = { plate: [480, 88], banner: [600, 100], wreath: [216, 216] }[kind], url = URL.createObjectURL(blobOfUri(uri));
  try {
    const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
    await waitFor(v, "loadedmetadata", 10000, "This device cannot play that video.");
    const len = Math.min(6, v.duration && isFinite(v.duration) ? v.duration : 0);
    if (!(len > 0.2)) throw new Error("The video is too short or its length is unknown.");
    const n = Math.max(4, Math.min(48, Math.round(len * 8))), cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols), [fw, fh] = cell;
    const cv = document.createElement("canvas"); cv.width = cols * fw; cv.height = rows * fh;
    const c = cv.getContext("2d")!;
    const k = Math.max(fw / v.videoWidth, fh / v.videoHeight), dw = v.videoWidth * k, dh = v.videoHeight * k;
    for (let i = 0; i < n; i++) {
      say?.(`Reading the video… ${i + 1} of ${n}`);
      const seeked = waitFor(v, "seeked", 6000, "The video would not seek."); v.currentTime = Math.min(len - 0.01, (i / n) * len); await seeked;
      const x = (i % cols) * fw, y = Math.floor(i / cols) * fh;
      c.save(); c.beginPath(); c.rect(x, y, fw, fh); c.clip(); c.drawImage(v, x + (fw - dw) / 2, y + (fh - dh) / 2, dw, dh);
      if (kind === "wreath" && K.hole) { c.globalCompositeOperation = "destination-out"; c.beginPath(); c.arc(x + fw / 2, y + fh / 2, (K.hole.r * fw) / K.w, 0, Math.PI * 2); c.fill(); }   // the avatar shows through the middle
      c.restore();
    }
    const art = cv.toDataURL("image/png");
    if (art.length > 9e6) throw new Error("That video makes too big a picture. Try a shorter or simpler clip.");
    return { art, cols, rows, frames: n, dur: +len.toFixed(2), vw: v.videoWidth, vh: v.videoHeight };
  } finally { URL.revokeObjectURL(url); }
}

/** Items from a file -> items ready to keep (videos turned into frames, animated pictures given a still one); anything that fails goes in `skipped`. */
async function prepare(items: PackItem[], skipped: { name: string; why: string }[], say?: (t: string) => void): Promise<PackItem[]> {
  const out: PackItem[] = [];
  for (const it of items) {
    try {
      if (it.mode === "video") {
        const src = it.src || "";
        const probe = await videoToSprite(src, it.kind || "plate", null).catch(() => null);
        let kind = it.kind;
        if (!kind) {
          if (!probe) throw new Error("This device cannot play that video.");
          const sh = probe.vw / probe.vh, keys = Object.keys(Pk.KINDS) as PackKind[];
          kind = keys.reduce((b, k) => (Math.abs(Math.log(sh / (Pk.KINDS[k].w / Pk.KINDS[k].h))) < Math.abs(Math.log(sh / (Pk.KINDS[b].w / Pk.KINDS[b].h))) ? k : b), "plate" as PackKind);
        }
        const sp = await videoToSprite(src, kind, say);
        out.push({ ...it, kind, id: Pk.idOf(kind, src.length + src.slice(0, 2000) + src.slice(-2000)), mode: "sprite", art: sp.art, cols: sp.cols, rows: sp.rows, frames: sp.frames, dur: sp.dur, still: "" });
      } else if (it.mode === "image" && it.moves && !it.still) out.push({ ...it, still: await firstFrame(it.art) });
      else out.push(it);
    } catch (e) { skipped.push({ name: it.name, why: e instanceof Error && e.message ? e.message : "could not be read" }); }
  }
  return out;
}

export interface ReadResult { items: PackItem[]; skipped: { name: string; why: string }[] }
/** Reads the files the person chose: packs, lone SVGs, pictures and short videos. */
export async function readFiles(files: File[], say?: (t: string) => void): Promise<ReadResult> {
  const found: PackItem[] = [], skipped: { name: string; why: string }[] = [];
  for (const f of files) {
    say?.(f.name);
    let r;
    try {
      if (f.size > Pk.LIMITS.file) r = { ok: false, error: "That file is too big.", items: [], skipped: [] } as ReturnType<typeof Pk.parseFile>;
      else if (/\.(asdeco|json|svg)$/i.test(f.name) || /json|svg/.test(f.type)) r = Pk.parseFile(await f.text(), f.name);
      else r = Pk.parseMedia(await dataUrlOf(f), f.name);
    } catch { r = { ok: false, error: "It could not be read.", items: [], skipped: [] } as ReturnType<typeof Pk.parseFile>; }
    if (r.ok) {
      found.push(...r.items.map((i) => ({ ...i, pack: r.name || "", author: r.author || "", license: r.license || "" })));
      skipped.push(...r.skipped.map((x) => ({ name: `${f.name}: ${x.name}`, why: x.why })));
    } else skipped.push({ name: f.name, why: r.error || "could not be read" });
  }
  const uniq = new Map<string, PackItem>();
  for (const it of found) if (!uniq.has(it.id)) uniq.set(it.id, it);   // the same decoration in two files is listed once
  return { items: await prepare([...uniq.values()], skipped, say), skipped };
}
