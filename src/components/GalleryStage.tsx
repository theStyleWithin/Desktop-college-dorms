import { sget, sset } from "../lib/scoped";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * What the Gallery's big viewer shows for one picture: a picture or GIF you can zoom (mouse wheel, + and -, buttons, double-click) and drag around,
 * or a video with a real player (play, seek, volume, speed, loop, full screen, and the video's size). Both can be shown four ways: fit to the
 * screen, actual size, fill (cropping the edges) or stretch (ignoring the shape). The way you chose is remembered on this device.
 */
export type Fit = "fit" | "actual" | "fill" | "stretch";
const FIT_KEY = "dorms.gallery.fit";
export const loadFit = (): Fit => {
  try { const v = sget(FIT_KEY); if (v === "fit" || v === "actual" || v === "fill" || v === "stretch") return v; } catch { /* not remembered */ }
  return "fit";
};
const saveFit = (f: Fit) => { try { sset(FIT_KEY, f); } catch { /* not remembered */ } };
const FITS: [Fit, string, string][] = [
  ["fit", "Fit", "Fit the whole picture on the screen"],
  ["actual", "1:1", "Actual size (drag to look around)"],
  ["fill", "Fill", "Fill the screen, cropping the edges"],
  ["stretch", "Stretch", "Stretch to the screen, ignoring the picture's shape"],
];
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, textarea, select");

function FitButtons({ fit, onFit }: { fit: Fit; onFit: (f: Fit) => void }) {
  return (
    <span className="gstage-group" role="group" aria-label="How the picture is sized">
      {FITS.map(([id, label, tip]) => <button key={id} type="button" className={`btn sm${fit === id ? " primary" : ""}`} aria-pressed={fit === id} title={tip} data-fit={id} onClick={() => onFit(id)}>{label}</button>)}
    </span>
  );
}

/** Zoom and drag for the picture or video inside a box: the wheel zooms around the pointer, drag moves, double-click toggles. */
function useZoom(resetOn: unknown[]) {
  const box = useRef<HTMLDivElement>(null);
  const [v, setV] = useState({ z: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setV({ z: 1, x: 0, y: 0 }); }, resetOn);
  const zoomTo = useCallback((f: (z: number) => number, cx = 0, cy = 0) => {
    setV((o) => { const nz = clamp(f(o.z), 0.1, 16); const k = nz / o.z; return { z: nz, x: cx - (cx - o.x) * k, y: cy - (cy - o.y) * k }; });
  }, []);
  const reset = useCallback(() => setV({ z: 1, x: 0, y: 0 }), []);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomTo((z) => z * Math.exp(-e.deltaY * 0.0015), e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, [zoomTo]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") zoomTo((z) => z * 1.25);
      else if (e.key === "-" || e.key === "_") zoomTo((z) => z / 1.25);
      else if (e.key === "0") reset();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [zoomTo, reset]);
  const handlers = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => { if (e.button !== 0) return; drag.current = { x: e.clientX, y: e.clientY, px: v.x, py: v.y, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => { const d = drag.current; if (!d) return; if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) d.moved = true; if (d.moved) setV((o) => ({ ...o, x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y })); },
    onPointerUp: () => { window.setTimeout(() => { drag.current = null; }, 0); },
    onDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => { const r = e.currentTarget.getBoundingClientRect(); if (v.z === 1) zoomTo(() => 2.5, e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)); else reset(); },
  };
  const wasDrag = () => !!drag.current?.moved;
  return { box, v, zoomTo, reset, handlers, wasDrag };
}

function ZoomButtons({ z, zoomTo, reset }: { z: number; zoomTo: (f: (z: number) => number) => void; reset: () => void }) {
  return (
    <span className="gstage-group" role="group" aria-label="Zoom">
      <button type="button" className="btn sm" aria-label="Zoom out" title="Zoom out (-)" data-testid="zoom-out" onClick={() => zoomTo((x) => x / 1.25)}>−</button>
      <button type="button" className="btn sm" title="Back to 100% (0)" data-testid="zoom-reset" onClick={reset}><span data-testid="zoom-level">{Math.round(z * 100)}%</span></button>
      <button type="button" className="btn sm" aria-label="Zoom in" title="Zoom in (+)" data-testid="zoom-in" onClick={() => zoomTo((x) => x * 1.25)}>+</button>
    </span>
  );
}

function ImageStage({ url, id, alt, fit, onFit }: { url: string; id: string; alt: string; fit: Fit; onFit: (f: Fit) => void }) {
  const { box, v, zoomTo, reset, handlers } = useZoom([id, fit]);
  const base: CSSProperties = fit === "fit" ? { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }
    : fit === "actual" ? { maxWidth: "none", maxHeight: "none" }
    : fit === "fill" ? { width: "100%", height: "100%", objectFit: "cover" }
    : { width: "100%", height: "100%", objectFit: "fill" };
  return (
    <div className="gstage" data-testid="stage-image" data-fit={fit}>
      <div ref={box} className="gstage-box" style={{ cursor: "grab" }} {...handlers}>
        <img src={url} alt={alt} draggable={false} data-testid="stage-img" decoding="async"
          style={{ ...base, transform: `translate(${v.x}px, ${v.y}px) scale(${v.z})`, transformOrigin: "center", userSelect: "none", willChange: "transform" }} />
      </div>
      <div className="gstage-bar" data-testid="stage-bar">
        <FitButtons fit={fit} onFit={onFit} />
        <ZoomButtons z={v.z} zoomTo={zoomTo} reset={reset} />
      </div>
    </div>
  );
}

const fmtTime = (s: number) => { if (!isFinite(s) || s < 0) s = 0; const m = Math.floor(s / 60), r = Math.floor(s % 60); return `${m}:${String(r).padStart(2, "0")}`; };

function VideoStage({ url, title, fit, onFit }: { url: string; title: string; fit: Fit; onFit: (f: Fit) => void }) {
  const vid = useRef<HTMLVideoElement>(null), wrap = useRef<HTMLDivElement>(null);
  const { box, v: zv, zoomTo, reset, handlers, wasDrag } = useZoom([url, fit]);
  const [playing, setPlaying] = useState(false), [time, setTime] = useState(0), [dur, setDur] = useState(0);
  const [vol, setVol] = useState(1), [muted, setMuted] = useState(false), [rate, setRate] = useState(1), [loop, setLoop] = useState(true);
  const [size, setSize] = useState(""), [err, setErr] = useState(""), [note, setNote] = useState("");
  const toggle = useCallback(() => { const e = vid.current; if (!e) return; if (e.paused) void e.play().catch(() => {}); else e.pause(); }, []);
  const full = useCallback(async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await wrap.current?.requestFullscreen(); setNote(""); }
    catch { setNote("Full screen isn't available here. The viewer already fills the window."); }
  }, []);
  useEffect(() => { if (vid.current) { vid.current.volume = vol; vid.current.muted = muted; vid.current.playbackRate = rate; } }, [vol, muted, rate]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const v = vid.current; if (!v) return;
      if (e.key === " " || e.key === "k" || e.key === "K") { e.preventDefault(); toggle(); }
      else if (e.key === "m" || e.key === "M") setMuted((m) => !m);
      else if (e.key === "f" || e.key === "F") void full();
      else if (e.shiftKey && e.key === "ArrowRight") { e.preventDefault(); v.currentTime = Math.min(v.duration || 0, v.currentTime + 5); }
      else if (e.shiftKey && e.key === "ArrowLeft") { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 5); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [toggle, full]);

  const objectFit = fit === "fit" ? "contain" : fit === "fill" ? "cover" : fit === "stretch" ? "fill" : "none";
  return (
    <div className="gstage" ref={wrap} data-testid="stage-video" data-fit={fit}>
      <div ref={box} className="gstage-box" style={{ cursor: "grab" }} {...handlers}>
        <video ref={vid} src={url} autoPlay loop={loop} playsInline preload="auto" data-testid="stage-vid"
          style={{ width: "100%", height: "100%", objectFit, transform: `translate(${zv.x}px, ${zv.y}px) scale(${zv.z})`, transformOrigin: "center", willChange: "transform" }}
          onClick={() => { if (!wasDrag()) toggle(); }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => { setDur(e.currentTarget.duration); setSize(`${e.currentTarget.videoWidth}×${e.currentTarget.videoHeight}`); setErr(""); }}
          onError={() => setErr(`This video can't be played here. The player uses your system's video codecs, and ${title} may use one that isn't installed (some 4K files use HEVC / H.265 or AV1).`)} />
        {err ? <div className="gstage-err" role="alert" data-testid="stage-video-error">{err}</div> : null}
      </div>
      <div className="gstage-bar" data-testid="video-bar">
        <button type="button" className="btn sm primary" aria-label={playing ? "Pause" : "Play"} title="Play / pause (Space)" data-testid="video-play" onClick={toggle}>{playing ? "⏸" : "▶"}</button>
        <span className="gstage-time" data-testid="video-time">{fmtTime(time)} / {fmtTime(dur)}</span>
        <input type="range" className="gstage-seek" min={0} max={dur || 0} step={0.05} value={Math.min(time, dur || 0)} aria-label="Seek" data-testid="video-seek"
          onChange={(e) => { const t = Number(e.target.value); if (vid.current) vid.current.currentTime = t; setTime(t); }} />
        <button type="button" className="btn sm" aria-label={muted ? "Unmute" : "Mute"} title="Mute (M)" data-testid="video-mute" onClick={() => setMuted((m) => !m)}>{muted || vol === 0 ? "🔇" : "🔊"}</button>
        <input type="range" className="gstage-vol" min={0} max={1} step={0.05} value={muted ? 0 : vol} aria-label="Volume" data-testid="video-volume" onChange={(e) => { const x = Number(e.target.value); setVol(x); setMuted(x === 0); }} />
        <select aria-label="Speed" title="Playback speed" data-testid="video-speed" value={rate} onChange={(e) => setRate(Number(e.target.value))}>
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => <option key={r} value={r}>{r}×</option>)}
        </select>
        <button type="button" className={`btn sm${loop ? " primary" : ""}`} aria-pressed={loop} title="Play again when it ends" data-testid="video-loop" onClick={() => setLoop((l) => !l)}>⟲</button>
        <FitButtons fit={fit} onFit={onFit} />
        <ZoomButtons z={zv.z} zoomTo={zoomTo} reset={reset} />
        <button type="button" className="btn sm" title="Full screen (F)" aria-label="Full screen" data-testid="video-full" onClick={() => void full()}>⛶</button>
        {size ? <span className="gstage-size" data-testid="video-size" title="The video's size in pixels">{size}{/^(\d+)×/.test(size) && Number(/^(\d+)×/.exec(size)![1]) >= 3800 ? " · 4K" : ""}</span> : null}
        {note ? <span className="hint" role="status">{note}</span> : null}
      </div>
    </div>
  );
}

/** The big picture or video for the viewer. */
export default function GalleryStage({ t }: { t: { id: string; url: string; kind: "image" | "gif" | "video"; title: string; note?: string } }) {
  const [fit, setFit] = useState<Fit>(loadFit);
  const pick = (f: Fit) => { setFit(f); saveFit(f); };
  return t.kind === "video"
    ? <VideoStage key={t.id} url={t.url} title={t.title} fit={fit} onFit={pick} />
    : <ImageStage id={t.id} url={t.url} alt={t.note ? `${t.title}: ${t.note}` : t.title} fit={fit} onFit={pick} />;
}
