import { useRef, useState } from "react";
import { open as pickFiles } from "@tauri-apps/plugin-dialog";
import { useStore } from "../store";
import { useLinkFiles } from "../lib/galleryLink";
import { api, galleryUrl, type Character, type GalleryMode } from "../api";
import { MOODS, detectMood } from "../lib/mood";
import { errText } from "../lib/util";
import PictureLinkBox, { pastedPicture } from "./PictureLinkBox";
import { useToast } from "./ui";

const MODES: { id: GalleryMode; label: string; hint: string }[] = [
  { id: "fixed", label: "Keep the main picture", hint: "The chat always shows the main picture. The gallery is just stored." },
  { id: "random", label: "Change randomly after each reply", hint: "After every reply, the chat shows a different picture from the gallery." },
  { id: "mood", label: "Match the mood of the reply", hint: "The chat shows the picture that fits how the reply feels (tag your pictures below). Anything that doesn't fit falls back to a calm or untagged picture, then the main one." },
];

/**
 * A character's gallery: more pictures (or GIFs and short videos) of them, each of which can be tagged with the moods it shows.
 * The chat then keeps the main picture, changes it at random after each reply, or picks the one that fits the reply's mood.
 */
export default function GalleryEditor({ char, onChanged }: { char: Character | null; onChanged: (c: Character) => void }) {
  const toast = useToast();
  const { info } = useStore();
  const [linkOn] = useLinkFiles();
  const canLink = info?.platform !== "android";
  const [busy, setBusy] = useState("");
  const [sample, setSample] = useState("");
  const file = useRef<HTMLInputElement>(null);
  if (!char) return <p className="hint">Save the character first, then you can add more pictures to their gallery here.</p>;

  const run = async (label: string, p: Promise<Character>) => {
    setBusy(label);
    try { onChanged(await p); } catch (e) { toast(errText(e), "err"); } finally { setBusy(""); }
  };
  /** Remembers where files are on this computer instead of copying them (for big videos). */
  const linkFiles = async () => {
    try {
      const p = await pickFiles({ multiple: true, directory: false, title: "Choose pictures or videos to link (they are not copied)", filters: [{ name: "Pictures and videos", extensions: ["png", "jpg", "jpeg", "webp", "avif", "bmp", "gif", "mp4", "webm", "mov", "m4v", "ogv"] }] });
      const list = !p ? [] : Array.isArray(p) ? p : [p];
      for (const path of list) {
        const name = path.split(/[\\/]/).pop() ?? path;
        setBusy(`Linking ${name}…`);
        try { onChanged(await api.linkGalleryFile(char.id, path)); } catch (e) { toast(`${name}: ${errText(e)}`, "err"); }
      }
    } catch (e) { toast(errText(e), "err"); } finally { setBusy(""); }
  };
  /** A linked file moved: choose where it is now (others from the same old folder that are in the new one come along). */
  const relocate = async (itemId: string) => {
    try {
      const p = await pickFiles({ multiple: false, directory: false, title: "Where is this file now?", filters: [{ name: "Pictures and videos", extensions: ["png", "jpg", "jpeg", "webp", "avif", "bmp", "gif", "mp4", "webm", "mov", "m4v", "ogv"] }] });
      if (!p || Array.isArray(p)) return;
      setBusy("Relocating…");
      const r = await api.relocateGalleryLink(char.id, itemId, p);
      onChanged(r.character);
      toast(r.also ? `Pointed at its new place, and ${r.also} more linked file${r.also === 1 ? "" : "s"} from the same folder.` : "Pointed at its new place.", "ok");
    } catch (e) { toast(errText(e), "err"); } finally { setBusy(""); }
  };
  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      setBusy(`Adding ${f.name}…`);
      try { onChanged(await api.addGalleryImage(char.id, f)); } catch (e) { toast(`${f.name}: ${errText(e)}`, "err"); }
    }
    setBusy("");
  };
  const mode = (char.gallery_mode || "fixed") as GalleryMode;
  const items = char.gallery ?? [];
  const seen = sample.trim() ? detectMood(sample) : null;
  const seenMood = MOODS.find((m) => m.id === seen);

  return (
    <div className="gallery" data-testid="gallery" onPaste={(e) => { const f = pastedPicture(e); if (f) { e.preventDefault(); void addFiles([f]); } }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void addFiles(e.dataTransfer.files); }}>
      <div className="chips" role="radiogroup" aria-label="How the gallery is used in a chat">
        {MODES.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} data-mode={m.id} className={`chip big ${mode === m.id ? "on" : ""}`} onClick={() => void run("Saving…", api.setGalleryMode(char.id, m.id))}>{m.label}</button>
        ))}
      </div>
      <div className="hint">{MODES.find((m) => m.id === mode)?.hint}</div>
      {mode === "mood" && items.length > 0 && !items.some((i) => i.moods.length) && <div className="hint" style={{ color: "#f4c76a" }}>No picture is tagged with a mood yet. Click the faces under a picture to say which moods it shows.</div>}

      <div className="gallery-grid">
        {items.map((it) => {
          const url = galleryUrl(char, it.id);
          return (
            <div key={it.id} className="gal-card" data-gal={it.id}>
              <div className="gal-thumb" data-linked={it.link ? "1" : undefined} title={it.link ? `Linked, not copied: ${it.link}` : undefined}>
                {url && (it.kind === "video" ? <video src={url} muted loop playsInline onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})} onMouseLeave={(e) => e.currentTarget.pause()} /> : <img src={url} alt="" draggable={false} loading="lazy" />)}
                {it.link ? <button type="button" className="btn sm gal-relink" data-testid="gallery-relocate" aria-label="Relocate this linked file" title="The file moved? Choose where it is now" disabled={!!busy} onClick={() => void relocate(it.id)}>📍 Relocate…</button> : null}
                {it.link && char.gallery_paths?.find((g) => g.id === it.id)?.missing ? <div className="gal-missing" data-testid="gallery-missing">File not found. If you moved it, press Relocate.</div> : null}
                <button type="button" className="iconbtn gal-del" aria-label="Remove this picture" title="Remove" onClick={() => { if (window.confirm("Remove this picture from the gallery?")) void run("Removing…", api.removeGalleryItem(char.id, it.id)); }}>✕</button>
              </div>
              <div className="gal-moods" aria-label="Moods this picture shows">
                {MOODS.map((m) => {
                  const on = it.moods.includes(m.id);
                  return <button key={m.id} type="button" className={`gal-mood${on ? " on" : ""}`} data-mood={m.id} aria-pressed={on} title={m.label}
                    onClick={() => void run("Saving…", api.setGalleryMoods(char.id, it.id, on ? it.moods.filter((x) => x !== m.id) : [...it.moods, m.id]))}>{m.emoji}</button>;
                })}
              </div>
            </div>
          );
        })}
        <button type="button" className="gal-add" disabled={!!busy} data-testid="gallery-add" onClick={() => (linkOn && canLink ? void linkFiles() : file.current?.click())}>＋<span>{linkOn && canLink ? "Link pictures" : "Add pictures"}</span></button>
      </div>
      {canLink ? (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center", margin: "6px 0" }}>
          {linkOn
            ? <button type="button" className="btn" disabled={!!busy} data-testid="gallery-copy-file" onClick={() => file.current?.click()}>Copy a file in instead…</button>
            : <button type="button" className="btn" disabled={!!busy} data-testid="gallery-link-file" onClick={() => void linkFiles()}>🔗 Link a file without copying…</button>}
          <small className="muted">{linkOn ? "Adding files here links them (the app remembers where they are). " : "For big videos: the app remembers where the file is and never copies, changes or deletes it. "}If you move a linked file it stops showing here. Linked files aren't in backups. You can make linking the usual way in Settings → Customization.</small>
        </div>
      ) : null}
      <PictureLinkBox testid="gallery-link" busy={!!busy} onFile={(f) => addFiles([f])} placeholder="…or paste a picture link to add it (https://…)" />
      <input ref={file} type="file" hidden multiple aria-label="Add gallery pictures" onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
      {busy && <div className="hint" role="status">{busy}</div>}
      {items.length === 0 && !busy && <div className="hint">Add pictures, GIFs or short videos of {char.card.name || "the character"} (drop them here too). With lots of expressions, tag each with its mood and pick “Match the mood of the reply”.</div>}

      <details style={{ marginTop: 10 }}>
        <summary>How does it tell the mood?</summary>
        <div className="hint" style={{ margin: "6px 0" }}>It reads each reply for feelings: actions in asterisks like *blushes* or *laughs*, words like “furious” or “giggles”, and emoji. Try it:</div>
        <input type="text" value={sample} aria-label="Try a reply" placeholder="*blushes and looks away* I-It's not like I missed you…" onChange={(e) => setSample(e.target.value)} />
        {seenMood && <div className="hint" data-testid="mood-sample" data-mood={seenMood.id}>That reads as <b>{seenMood.emoji} {seenMood.label}</b>.</div>}
      </details>
    </div>
  );
}
