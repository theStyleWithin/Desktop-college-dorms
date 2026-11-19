import { useEffect, useRef, useState } from "react";
import { emojiUrl, type EmojiItem } from "../api";

/** The emoji button beside the message box: the emoji and stickers this room has. An emoji is added to the message; a sticker is sent. */
export default function EmojiPicker({ items, disabled, onEmoji, onSticker }: { items: EmojiItem[]; disabled?: boolean; onEmoji: (name: string) => void; onSticker: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", f); window.addEventListener("keydown", k);
    return () => { window.removeEventListener("mousedown", f); window.removeEventListener("keydown", k); };
  }, [open]);
  const emoji = items.filter((i) => i.kind === "emoji"), stickers = items.filter((i) => i.kind === "sticker");
  return (
    <span ref={box} style={{ position: "relative", display: "inline-flex" }}>
      <button type="button" className="btn" aria-label="Emoji and stickers" aria-expanded={open} data-testid="emoji-button" title="Emoji and stickers" disabled={disabled} onClick={() => setOpen((o) => !o)}>😊</button>
      {open && (
        <div className="emoji-picker" role="dialog" aria-label="Emoji and stickers" data-testid="emoji-picker">
          {items.length === 0 && <p className="fine" style={{ margin: 0 }}>No emoji or stickers here yet. Add some in Settings → Emoji &amp; stickers.</p>}
          {emoji.length > 0 && <><b>Emoji</b><div className="grid">{emoji.map((i) => <button key={i.id} type="button" className="pick" data-pick-emoji={i.name} title={`:${i.name}:${i.meaning ? " · " + i.meaning : ""}`} onClick={() => { onEmoji(i.name); setOpen(false); }}><img src={emojiUrl(i)} alt={i.name} /></button>)}</div></>}
          {stickers.length > 0 && <><b>Stickers</b> <small className="muted">(click to send)</small><div className="grid">{stickers.map((i) => <button key={i.id} type="button" className="pick" data-pick-sticker={i.name} title={`${i.name}${i.meaning ? " · " + i.meaning : ""}`} onClick={() => { onSticker(i.name); setOpen(false); }}><img src={emojiUrl(i)} alt={i.name} /></button>)}</div></>}
        </div>
      )}
    </span>
  );
}
