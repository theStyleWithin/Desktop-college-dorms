import { useEffect, useRef, useState } from "react";

const KEY = "dorms.music";
const load = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || "{}"); return { volume: typeof v.volume === "number" ? v.volume : 0.5, muted: !!v.muted, paused: !!v.paused }; } catch { return { volume: 0.5, muted: false, paused: false }; } };
const save = (v: { volume: number; muted: boolean; paused: boolean }) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* ignore */ } };

/**
 * Background music on a loop. WebKitGTK can't stream audio from the app's own file scheme, so the file is fetched
 * into memory and played from a blob. It starts by itself; if the system holds it back until you click, a ▶ button
 * says so. Volume, mute and pause are remembered.
 */
export default function MusicPlayer({ src, name }: { src: string; name: string }) {
  const [blob, setBlob] = useState<string | null>(null);
  const [st, setSt] = useState(load);
  const [playing, setPlaying] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [err, setErr] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const stRef = useRef(st); stRef.current = st;

  useEffect(() => {
    let alive = true, obj: string | null = null;
    setBlob(null); setErr(false); setPlaying(false);
    const ext = (decodeURIComponent(src).split("?")[0].split(".").pop() || "mp3").toLowerCase();
    const mime = ({ mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac" } as Record<string, string>)[ext] ?? "audio/mpeg";
    fetch(src).then((r) => r.blob()).then((b) => { if (!alive) return; obj = URL.createObjectURL(new Blob([b], { type: mime })); setBlob(obj); }).catch(() => alive && setErr(true));
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
  }, [src]);

  useEffect(() => {
    const a = audio.current;
    if (!a || !blob) return;
    a.volume = st.volume; a.muted = st.muted;
  }, [blob, st.volume, st.muted]);

  useEffect(() => {
    const a = audio.current;
    if (!a || !blob) return;
    if (st.paused) { a.pause(); return; }
    a.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
  }, [blob, st.paused]);

  const set = (p: Partial<typeof st>) => setSt((x) => { const n = { ...x, ...p }; save(n); return n; });
  const toggle = () => { const a = audio.current; if (blocked && a) { a.play().then(() => { setBlocked(false); set({ paused: false }); }).catch(() => {}); return; } set({ paused: !st.paused }); };

  if (err) return <span className="music-bar" title="The music file couldn't be loaded">🎵 ⚠</span>;
  return (
    <span className="music-bar" data-testid="music" data-playing={playing ? "1" : "0"} data-blocked={blocked ? "1" : "0"}>
      {blob && <audio ref={audio} src={blob} loop preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />}
      <button className="btn ghost sm" onClick={toggle} aria-label={blocked || st.paused ? "Play music" : "Pause music"} title={name}>{blocked || st.paused ? "▶" : "⏸"}</button>
      <span className="music-name" title={name}>🎵 {name}</span>
      <button className="btn ghost sm" onClick={() => set({ muted: !st.muted })} aria-label={st.muted ? "Unmute music" : "Mute music"}>{st.muted || st.volume === 0 ? "🔇" : "🔊"}</button>
      <input type="range" min={0} max={1} step={0.02} value={st.muted ? 0 : st.volume} aria-label="Music volume" onChange={(e) => set({ volume: Number(e.target.value), muted: false })} />
    </span>
  );
}
