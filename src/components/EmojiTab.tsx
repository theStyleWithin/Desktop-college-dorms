import { useRef, useState } from "react";
import { api, emojiUrl, type EmojiItem } from "../api";
import { reloadEmoji, useEmoji } from "../lib/emoji";
import { pathName } from "../lib/rooms";
import { errText } from "../lib/util";
import { useStore } from "../store";
import { useToast } from "./ui";
import PictureLinkBox from "./PictureLinkBox";

const MAX = { emoji: 50, sticker: 30 };

/** Settings → Emoji & stickers: your own pictures, each working everywhere or only in one room. Characters can use them too. */
export default function EmojiTab() {
  const { rooms } = useStore();
  const all = useEmoji();
  const toast = useToast();
  const [scope, setScope] = useState<string>("");   // where new ones go: "" = everywhere, else a room id
  const [busy, setBusy] = useState(false);
  const emojiInput = useRef<HTMLInputElement>(null), stickerInput = useRef<HTMLInputElement>(null);
  const list = (kind: "emoji" | "sticker") => all.filter((i) => i.kind === kind);

  const add = async (kind: "emoji" | "sticker", files: FileList | File[] | null) => {
    if (!files?.length) return;
    setBusy(true);
    let made = 0;
    for (const f of Array.from(files)) {
      try { await api.addEmoji(f, kind, "", "", scope ? Number(scope) : null); made++; } catch (e) { toast(`${f.name}: ${errText(e)}`, "err"); }
    }
    await reloadEmoji(); setBusy(false);
    if (made) toast(`Added ${made} ${kind === "emoji" ? "emoji" : made === 1 ? "sticker" : "stickers"}.`, "ok");
  };

  return (
    <div className="emoji-tab" data-testid="emoji-tab">
      <h3>Emoji &amp; stickers</h3>
      <p className="sub">Your own pictures for chat. Type an <b>emoji</b> as <code>:name:</code> or pick it beside the message box; a <b>sticker</b> is a bigger picture you send as a whole message. Give each a short meaning, and the characters will know when to use them too. Each one works everywhere, or only in one room, like a server's own. The pictures are copied into the app, so your folders stay untouched.</p>
      <label className="field" style={{ maxWidth: 420 }}><span>New ones work in</span>
        <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Where new ones work" data-testid="emoji-scope">
          <option value="">Everywhere</option>
          {rooms.map((r) => <option key={r.id} value={r.id}>{pathName(rooms, r.id)}</option>)}
        </select></label>
      {(["emoji", "sticker"] as const).map((kind) => (
        <section key={kind} className="emoji-section" data-testid={`emoji-${kind}`}>
          <h4>{kind === "emoji" ? "Emoji" : "Stickers"} <span className="m-count">{list(kind).length} of {MAX[kind]}</span></h4>
          <div className="btnrow">
            <button className="btn primary" disabled={busy || list(kind).length >= MAX[kind]} onClick={() => (kind === "emoji" ? emojiInput : stickerInput).current?.click()}>＋ Add {kind === "emoji" ? "emoji" : "stickers"}</button>
            <input ref={kind === "emoji" ? emojiInput : stickerInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden data-testid={`emoji-file-${kind}`} onChange={(e) => { void add(kind, e.target.files); e.target.value = ""; }} />
            <small className="muted">Any size of PNG, JPG, WebP or GIF: it is shrunk to fit and made into {kind === "emoji" ? "an emoji" : "a sticker"} for you (animated GIFs stay animated). The file name becomes its name.</small>
          </div>
          <PictureLinkBox testid={`emoji-link-${kind}`} busy={busy || list(kind).length >= MAX[kind]} placeholder={`…or copy ${kind === "emoji" ? "an emoji" : "a sticker"} from a picture link (https://…)`} onFile={async (f) => { await add(kind, [f]); }} />
          <div className="emoji-list">
            {list(kind).map((it) => <EmojiRow key={it.id} it={it} />)}
            {list(kind).length === 0 && <p className="fine">None yet.</p>}
          </div>
        </section>
      ))}
    </div>
  );
}

function EmojiRow({ it }: { it: EmojiItem }) {
  const { rooms } = useStore();
  const toast = useToast();
  const [name, setName] = useState(it.name), [meaning, setMeaning] = useState(it.meaning);
  const save = async (patch: { name?: string; meaning?: string; room?: number | null }) => {
    try { await api.updateEmoji(it.id, patch.name ?? name, patch.meaning ?? meaning, patch.room === undefined ? it.room_id : patch.room); await reloadEmoji(); }
    catch (e) { toast(errText(e), "err"); setName(it.name); setMeaning(it.meaning); }
  };
  return (
    <div className="emoji-row" data-emoji-row={it.name} data-kind={it.kind}>
      <img className={it.kind === "emoji" ? "emoji big" : "sticker prev"} src={emojiUrl(it)} alt={it.name} />
      <div className="emoji-fields">
        <label><span>Name</span><input value={name} maxLength={24} aria-label="Name" onChange={(e) => setName(e.target.value)} onBlur={() => name !== it.name && void save({ name })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} /></label>
        <label><span>Meaning (so characters know when to use it)</span><input value={meaning} maxLength={80} placeholder="e.g. celebrating, or a shy wave" aria-label="Meaning" onChange={(e) => setMeaning(e.target.value)} onBlur={() => meaning !== it.meaning && void save({ meaning })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} /></label>
        <label><span>Works in</span>
          <select value={it.room_id ?? ""} aria-label="Works in" onChange={(e) => void save({ room: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Everywhere</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{pathName(rooms, r.id)}</option>)}
          </select></label>
      </div>
      <div className="emoji-use"><code>{it.kind === "emoji" ? `:${it.name}:` : `[sticker: ${it.name}]`}</code>
        <button className="btn danger sm" aria-label={`Delete ${it.name}`} onClick={async () => { if (!window.confirm(`Delete "${it.name}"?`)) return; try { await api.deleteEmoji(it.id); await reloadEmoji(); } catch (e) { toast(errText(e), "err"); } }}>🗑</button></div>
    </div>
  );
}
