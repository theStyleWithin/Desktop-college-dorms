import { useEffect, useMemo, useRef, useState } from "react";
import {
  api, blankCard, mediaUrl, type CardData, type Character, type Frame, type Lorebook, type MediaKind,
} from "../api";
import Art from "../components/Art";
import FrameEditor from "../components/FrameEditor";
import BookEditor from "../components/BookEditor";
import { makeWardrobe } from "../components/WardrobePanel";
import { TagInput, useToast } from "../components/ui";
import { errText, tokens } from "../lib/util";
import { useStore } from "../store";

const kindOf = (f: File): MediaKind | null => {
  const n = f.name.toLowerCase();
  if (n.endsWith(".vrm")) return "vrm";
  if (n.endsWith(".gif")) return "gif";
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(n)) return "video";
  if (/\.(png|jpe?g|webp|avif|bmp)$/.test(n)) return "image";
  return null;
};

function Field({ label, req, hint, count, plain, children }: { label: string; req?: boolean; hint?: string; count?: string; plain?: boolean; children: React.ReactNode }) {
  // `plain` is for fields that hold several buttons (a <label> would hijack their clicks)
  const Wrap = plain ? "div" : "label";
  return (
    <Wrap className="f">
      <span>{req && <span className="req">* </span>}{label}:</span>
      <span>
        {children}
        {hint && <div className="hint">{hint}</div>}
        {count && <div className="tok">{count}</div>}
      </span>
    </Wrap>
  );
}

const tk = (s: string) => `${tokens(s)} token(s)`;

export default function Editor({ id }: { id: string | null }) {
  const { go, refresh, settings } = useStore();
  const toast = useToast();
  const [loaded, setLoaded] = useState(id === null);
  const [char, setChar] = useState<Character | null>(null);
  const [card, setCard] = useState<CardData>(blankCard());
  const [name, setName] = useState("");
  const [chatName, setChatName] = useState("");
  const [tagline, setTagline] = useState("");
  const [note, setNote] = useState({ prompt: "", depth: 4 });
  const [pending, setPending] = useState<{ file: File; url: string; kind: MediaKind; frame?: Frame | null } | null>(null);
  // a picture being positioned: a freshly chosen file (`file`), or the saved one being re-framed
  const [framing, setFraming] = useState<{ file?: File; url: string; kind: MediaKind; initial?: Frame | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [trusted, setTrusted] = useState(true);
  const [library, setLibrary] = useState<Lorebook[]>([]);
  const [attached, setAttached] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const hydrate = (c: Character) => {
    const d = c.card.extensions?.dorms ?? {};
    const dn = String(d.display_name ?? "");
    setChar(c);
    setAttached(c.lorebooks ?? []);
    setTrusted(c.trusted !== false);
    setCard(c.card);
    setName(dn || c.card.name);
    setChatName(dn ? c.card.name : "");
    setTagline(String(d.tagline ?? ""));
    const dp = c.card.extensions?.depth_prompt;
    setNote({ prompt: String(dp?.prompt ?? ""), depth: Number(dp?.depth ?? 4) || 4 });
    setDirty(false);
  };

  useEffect(() => {
    if (id) api.getCharacter(id).then((c) => { if (c) hydrate(c); setLoaded(true); });
  }, [id]);
  useEffect(() => { api.listLorebooks().then(setLibrary).catch(() => {}); }, []);
  useEffect(() => () => { if (pending) URL.revokeObjectURL(pending.url); }, [pending]);

  const set = <K extends keyof CardData>(k: K, v: CardData[K]) => { setCard((c) => ({ ...c, [k]: v })); setDirty(true); };

  /** Assemble the card, moving app-level fields into `extensions` like a spec-compliant tool would. */
  const built = useMemo((): CardData => {
    const n = name.trim(), cn = chatName.trim();
    const ext = { ...card.extensions };
    const dorms = { ...(ext.dorms ?? {}) };
    if (tagline.trim()) dorms.tagline = tagline.trim(); else delete dorms.tagline;
    if (cn && cn !== n) dorms.display_name = n; else delete dorms.display_name;
    if (Object.keys(dorms).length) ext.dorms = dorms; else delete ext.dorms;
    if (note.prompt.trim()) ext.depth_prompt = { ...(ext.depth_prompt ?? {}), prompt: note.prompt, depth: note.depth, role: ext.depth_prompt?.role ?? "system" };
    else delete ext.depth_prompt;
    return { ...card, name: cn || n, extensions: ext };
  }, [card, name, chatName, tagline, note]);

  const total = tokens(card.description) + tokens(card.personality) + tokens(card.scenario) + tokens(card.first_mes) + tokens(card.mes_example)
    + tokens(card.system_prompt) + tokens(card.post_history_instructions) + tokens(note.prompt);
  const permanent = tokens(card.description) + tokens(card.personality) + tokens(card.scenario) + tokens(card.system_prompt) + tokens(card.post_history_instructions) + tokens(note.prompt);

  const pickMedia = async (f: File | undefined) => {
    if (!f) return;
    const kind = kindOf(f);
    if (!kind) return toast("Use a JPG, PNG, WebP, GIF, MP4/WebM video, or a VRM model.", "err");
    // pictures get a chance to be positioned first, so the face is never cut off
    if (kind === "image" || kind === "gif") { setFraming({ file: f, url: URL.createObjectURL(f), kind }); return; }
    await applyMedia(f, kind, null);
  };

  const applyMedia = async (f: File, kind: MediaKind, frame: Frame | null) => {
    if (char) {
      try {
        let c = await api.setMedia(char.id, f);
        c = await api.setFrame(c.id, frame);
        hydrate(c); toast("Media updated", "ok"); refresh();
      } catch (e) { toast(errText(e), "err"); }
    } else {
      if (pending) URL.revokeObjectURL(pending.url);
      setPending({ file: f, url: URL.createObjectURL(f), kind, frame });
      setDirty(true);
    }
  };

  /** Re-frame the picture that is already saved (or the one waiting to be saved with a new character). */
  const reframe = async (f: Frame | null) => {
    setFraming(null);
    if (pending) { setPending({ ...pending, frame: f }); return; }
    if (!char) return;
    try { const c = await api.setFrame(char.id, f); setChar(c); refresh(); toast("Framing saved", "ok"); } catch (e) { toast(errText(e), "err"); }
  };

  const save = async (): Promise<Character | null> => {
    if (!name.trim() && !chatName.trim()) { toast("Give your character a name first.", "err"); return null; }
    setSaving(true);
    try {
      let saved = await api.saveCharacter({ ...(char ?? {}), card: built, trusted, lorebooks: attached });
      if (pending) { saved = await api.setMedia(saved.id, pending.file); if (pending.frame) saved = await api.setFrame(saved.id, pending.frame); setPending(null); }
      hydrate(saved);
      await refresh();
      toast("Saved", "ok");
      if (!char) go({ page: "editor", id: saved.id });
      return saved;
    } catch (e) { toast(`Could not save: ${errText(e)}`, "err"); return null; }
    finally { setSaving(false); }
  };

  const exp = async (fmt: "png" | "json_v2" | "json_v3") => {
    const c = dirty || !char ? await save() : char;
    if (!c) return;
    try { if (await api.exportCard(c.id, fmt, built.name || "character")) toast("Exported", "ok"); }
    catch (e) { toast(`Export failed: ${errText(e)}`, "err"); }
  };

  const chat = async () => {
    const c = dirty || !char ? await save() : char;
    if (!c) return;
    const ch = await api.createChat(null, built.name, "dm", [c.id]);
    await refresh();
    go({ page: "chat", chatId: ch.id });
  };

  const del = async () => {
    if (!char || !window.confirm(`Delete ${built.name}? This can't be undone.`)) return;
    await api.deleteCharacter(char.id); await refresh(); go({ page: "library" });
  };

  // ---- lorebook helpers
  const book = card.character_book;
  const setBook = (b: CardData["character_book"]) => set("character_book", b);

  if (!loaded) return <div className="page sub">Loading…</div>;

  const previewKind = pending?.kind ?? char?.media?.kind ?? null;
  const previewUrl = pending?.url ?? (char ? mediaUrl(char) : null);

  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <div className="page-head">
        <div>
          <button className="btn ghost sm" onClick={() => go({ page: "library" })}>← Characters</button>
          <h1>{char ? "Edit character" : "Create character"}</h1>
          <div className="sub">{dirty ? "Unsaved changes" : char ? "All changes saved" : "Everything stays on your device."}</div>
        </div>
        {char && (
          <div className="row">
            <button className="btn" onClick={chat}>💬 Chat</button>
            <button className="btn" onClick={() => exp("png")}>Export PNG</button>
            <button className="btn" onClick={() => exp("json_v2")}>JSON V2</button>
            <button className="btn" onClick={() => exp("json_v3")}>JSON V3</button>
          </div>
        )}
      </div>

      <h2>Character Info <span className="sub" style={{ fontSize: ".9rem", fontFamily: "var(--sans)" }}>(how they look in your library)</span></h2>
      <Field label="Name" req><input type="text" value={name} placeholder="Name" onChange={(e) => { setName(e.target.value); setDirty(true); }} /></Field>
      <Field label="Avatar" plain hint="JPG, PNG, WebP, GIF, MP4/WebM video, or a VRM / VRoid model (.vrm). Choose Upload, or drop a file onto the picture. Videos and GIFs animate; VRM models stand in a 3D room you can look around.">
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div className="editor-media" title="Drop an image, GIF, video or .vrm model here"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); pickMedia(e.dataTransfer.files?.[0]); }}>
            <Art kind={previewKind} url={previewUrl} name={name || "?"} frame={pending ? pending.frame : char?.frame} mode="full" wardrobe={pending ? undefined : makeWardrobe(char, (n) => { hydrate(n); refresh(); }, toast)} />
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>⇪ Upload</button>
            {previewUrl && (previewKind === "image" || previewKind === "gif") && (
              <button type="button" className="btn" onClick={() => setFraming({ url: previewUrl, kind: previewKind, initial: pending ? pending.frame : char?.frame })}>⤧ Position</button>
            )}
            {(previewUrl) && (
              <button type="button" className="btn danger" onClick={async () => {
                if (pending) { setPending(null); return; }
                if (char) { hydrate(await api.clearMedia(char.id)); refresh(); }
              }}>Remove</button>
            )}
            {/* No `accept` filter on purpose: file pickers build their list from MIME types, and ".vrm" has none, so a
                filter can hide VRM models entirely. Anything can be chosen; unsupported types get a clear message. */}
            <input ref={fileRef} type="file" hidden onChange={(e) => { pickMedia(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
        </div>
      </Field>
      <Field label="Tagline" hint="Short line shown on the character card. Not part of the prompt."><input type="text" value={tagline} placeholder="Short tagline about your character" onChange={(e) => { setTagline(e.target.value); setDirty(true); }} /></Field>
      <Field label="In-Chat Name" hint="Optional. The name used inside chats, if different from the name above."><input type="text" value={chatName} placeholder="Some name, if different from the name above" onChange={(e) => { setChatName(e.target.value); setDirty(true); }} /></Field>
      <Field label="Creator's Notes" hint="Shown to you only; not part of the prompt."><textarea value={card.creator_notes} placeholder="Short introduction about your character" onChange={(e) => set("creator_notes", e.target.value)} /></Field>
      <Field label="Tags"><TagInput value={card.tags} onChange={(v) => set("tags", v)} placeholder="Gender, type, genre… press Enter" /></Field>

      <h2 className="sect">Character Definition <span className="sub" style={{ fontSize: ".9rem", fontFamily: "var(--sans)" }}>(how your character will act)</span></h2>
      <Field label="Description" req count={tk(card.description)} hint="The character's persona. Think of this as a description and definitions in one box.">
        <textarea style={{ minHeight: 180 }} value={card.description} placeholder="Description" onChange={(e) => set("description", e.target.value)} />
      </Field>
      <Field label="Initial message" req count={tk(card.first_mes)} hint="First message from your character. A lengthy first message encourages longer replies.">
        <textarea style={{ minHeight: 130 }} value={card.first_mes} placeholder="First message" onChange={(e) => set("first_mes", e.target.value)} />
      </Field>
      <Field label="Scenario" count={tk(card.scenario)} hint="The current circumstances and context of the conversation.">
        <textarea value={card.scenario} placeholder="Scenario" onChange={(e) => set("scenario", e.target.value)} />
      </Field>
      <Field label="Example dialogs" count={tk(card.mes_example)} hint="Example chat between you and the character. Very important for teaching how they speak. Separate examples with <START>.">
        <textarea style={{ minHeight: 140 }} value={card.mes_example} placeholder="Example dialogs" onChange={(e) => set("mes_example", e.target.value)} />
      </Field>
      <Field label="More initial messages" plain hint="Other ways for the chat to begin. When you start a chat you choose which message opens it; the others stay one swipe (‹ ›) away on the first message.">
        <div style={{ display: "grid", gap: 8 }}>
          {card.alternate_greetings.map((g, i) => (
            <div key={i} className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
              <span className="tok" style={{ paddingTop: 10, width: 22 }}>{i + 2}.</span>
              <textarea value={g} aria-label={`Initial message ${i + 2}`} style={{ minHeight: 90 }} placeholder={`Initial message ${i + 2}`} onChange={(e) => set("alternate_greetings", card.alternate_greetings.map((x, j) => (j === i ? e.target.value : x)))} />
              <button type="button" className="btn danger sm" aria-label={`Remove initial message ${i + 2}`} onClick={() => set("alternate_greetings", card.alternate_greetings.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button type="button" className="btn sm" style={{ justifySelf: "start" }} onClick={() => set("alternate_greetings", [...card.alternate_greetings, ""])}>＋ Add another initial message</button>
        </div>
      </Field>
      <h2 className="sect">Lorebooks <span className="sub" style={{ fontSize: ".9rem", fontFamily: "var(--sans)" }}>(lore that appears when keywords come up)</span></h2>
      <Field label="Shared lorebooks" plain hint="Books from your Lorebooks library. Attach the same world to as many characters as you like.">
        <div style={{ display: "grid", gap: 6 }}>
          {library.map((b) => (
            <label key={b.id} className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={attached.includes(b.id)} onChange={(e) => { setAttached(e.target.checked ? [...attached, b.id] : attached.filter((x) => x !== b.id)); setDirty(true); }} />
              📚 {b.name} <span className="tok">{b.book?.entries?.length ?? 0} entries</span>
            </label>
          ))}
          {!library.length && <div className="hint">No lorebooks in your library yet.</div>}
          <button type="button" className="btn sm" style={{ justifySelf: "start" }} onClick={() => go({ page: "lorebooks" })}>Open Lorebooks</button>
        </div>
      </Field>
      <Field label="This card's own book" plain hint="Lore that travels inside the character card itself (exports with the card). Keys can be /regex/i.">
        {!book ? (
          <button type="button" className="btn" onClick={() => setBook({ name: "", description: "", scan_depth: null, token_budget: null, recursive_scanning: null, extensions: {}, entries: [] })}>＋ Add a book to this card</button>
        ) : (
          <BookEditor book={book} setBook={setBook} onRemove={() => setBook(null)} />
        )}
      </Field>
      <p className="tok" style={{ textAlign: "center" }}>Total: {total} token(s). Permanent: {permanent} token(s). Your context window is {settings.context_tokens}.</p>

      <details className="card" style={{ marginTop: 24 }} open>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Advanced Definitions</summary>
        <Field label="Personality" count={tk(card.personality)} hint="Optional trait summary (part of the standard card spec).">
          <textarea value={card.personality} onChange={(e) => set("personality", e.target.value)} />
        </Field>
        {(card.system_prompt.trim() || card.post_history_instructions.trim()) && (
          <div className={trusted ? "hint" : "banner"} style={{ margin: "12px 0" }}>
            <span style={{ fontSize: "1.3rem" }}>{trusted ? "🔓" : "🛡️"}</span>
            <div className="grow">
              {trusted
                ? "This card is trusted: its system prompt and post-history instructions can take priority over the app's own instructions."
                : "This card's system prompt and post-history instructions are being used only as lower-priority notes, because the card came from outside. Trust it if you know and like what they say."}
            </div>
            <button type="button" className={trusted ? "btn sm" : "btn primary sm"} onClick={() => { setTrusted(!trusted); setDirty(true); }}>{trusted ? "Stop trusting" : "Trust this card"}</button>
          </div>
        )}
        <Field label="System prompt" count={tk(card.system_prompt)} hint="Replaces the default system prompt for this character. Use {{original}} to include the default. Applied when 'use card prompts' is on in Settings.">
          <textarea value={card.system_prompt} placeholder="System Prompt" onChange={(e) => set("system_prompt", e.target.value)} />
        </Field>
        <Field label="Post-history instructions" count={tk(card.post_history_instructions)} hint="Instructions placed after the chat history, right before the model replies. Include {{original}} to supplement rather than replace.">
          <textarea value={card.post_history_instructions} placeholder="Post History Instructions" onChange={(e) => set("post_history_instructions", e.target.value)} />
        </Field>
        <Field label="Character's note" count={tk(note.prompt)} hint="Inserted into the chat history at this depth (messages from the end).">
          <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
            <textarea style={{ minHeight: 70 }} value={note.prompt} placeholder="Character's Note" onChange={(e) => { setNote({ ...note, prompt: e.target.value }); setDirty(true); }} />
            <input type="number" min={1} style={{ width: 80 }} aria-label="Depth" value={note.depth} onChange={(e) => { setNote({ ...note, depth: Math.max(1, Number(e.target.value) || 1) }); setDirty(true); }} />
          </div>
        </Field>
        <Field label="Creator"><input type="text" value={card.creator} onChange={(e) => set("creator", e.target.value)} /></Field>
        <Field label="Version"><input type="text" value={card.character_version} onChange={(e) => set("character_version", e.target.value)} /></Field>

      </details>

      {framing && (
        <FrameEditor src={framing.url} initial={framing.initial} onClose={() => { if (framing.file) URL.revokeObjectURL(framing.url); setFraming(null); }}
          onSave={(fr) => { if (framing.file) { const f = framing.file, u = framing.url; setFraming(null); void applyMedia(f, framing.kind, fr).finally(() => URL.revokeObjectURL(u)); } else void reframe(fr); }} />
      )}
      <div className="sticky-bar">
        <button className="btn primary" onClick={save} disabled={saving}>{saving ? "Saving…" : char ? "Save changes" : "Create Character"}</button>
        {char && <button className="btn danger" onClick={del}>Delete</button>}
        <span className="tok">{dirty ? "Unsaved changes" : ""}</span>
      </div>
    </div>
  );
}
