import { useRef } from "react";

/** Choose, replace or remove a music file from the computer. `name` is the file's name when there is one. */
export default function MusicField({ name, onPick, onRemove, busy }: { name: string; onPick: (f: File) => void; onRemove: () => void; busy?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="row" style={{ gap: 8 }}>
      <span className="music-chip" data-testid="music-name">{name ? `🎵 ${name}` : "No music"}</span>
      <button type="button" className="btn" disabled={busy} onClick={() => ref.current?.click()}>{name ? "Change music" : "Choose music file"}</button>
      {name && <button type="button" className="btn ghost" disabled={busy} onClick={onRemove}>Remove</button>}
      {/* explicit extensions as well as audio/*: some file pickers only list what is spelled out */}
      <input ref={ref} type="file" hidden accept="audio/*,.mp3,.ogg,.oga,.opus,.wav,.m4a,.aac,.flac" aria-label="Music file"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onPick(f); }} />
    </div>
  );
}
