import { useEffect, useMemo, useRef, useState } from "react";
import {
  api, blankCard, blankEntry, mediaUrl, type BookEntry, type CardData, type Character, type MediaKind,
} from "../api";
import Art from "../components/Art";
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
  const [pending, setPending] = useState<{ file: File; url: string; kind: MediaKind } | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [trusted, setTrusted] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  const hydrate = (c: Character) => {
    const d = c.card.extensions?.dorms ?? {};
    const dn = String(d.display_name ?? "");
    setChar(c);
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
    if (char) {
      try { hydrate(await api.setMedia(char.id, f)); toast("Media updated", "ok"); refresh(); } catch (e) { toast(errText(e), "err"); }
    } else {
      if (pending) URL.revokeObjectURL(pending.url);
      setPending({ file: f, url: URL.createObjectURL(f), kind });
      setDirty(true);
    }
  };

  const save = async (): Promise<Character | null> => {
    if (!name.trim() && !chatName.trim()) { toast("Give your character a name first.", "err"); return null; }
    setSaving(true);
    try {
      let saved = await api.saveCharacter({ ...(char ?? {}), card: built, trusted });
      if (pending) { saved = await api.setMedia(saved.id, pending.file); setPending(null); }
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
  const setEntry = (i: number, patch: Partial<BookEntry>) =>
    setBook({ ...book!, entries: book!.entries.map((e, j) => (j === i ? { ...e, ...patch } : e)) });

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
            <Art kind={previewKind} url={previewUrl} name={name || "?"} mode="full" />
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>⇪ Upload</button>
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
      <p className="tok" style={{ textAlign: "center" }}>Total: {total} token(s). Permanent: {permanent} token(s). Your context window is {settings.context_tokens}.</p>

      <details className="card" style={{ marginTop: 24 }} open>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Advanced Definitions</summary>
        <Field label="Personality" count={tk(card.personality)} hint="Optional trait summary (part of the standard card spec).">
          <textarea value={card.personality} onChange={(e) => set("personality", e.target.value)} />
        </Field>
        <Field label="Alternate greetings" hint="Alternate beginning messages. You can flip between them as swipes on the first message.">
          <div style={{ display: "grid", gap: 8 }}>
            {card.alternate_greetings.map((g, i) => (
              <div key={i} className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
                <textarea value={g} style={{ minHeight: 70 }} onChange={(e) => set("alternate_greetings", card.alternate_greetings.map((x, j) => (j === i ? e.target.value : x)))} />
                <button type="button" className="btn danger sm" onClick={() => set("alternate_greetings", card.alternate_greetings.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <button type="button" className="btn sm" style={{ justifySelf: "start" }} onClick={() => set("alternate_greetings", [...card.alternate_greetings, ""])}>＋ Add alternate greeting</button>
          </div>
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

        <Field label="Character Book" hint="Keyword-triggered lore. When a key appears in recent messages, its content is added to the prompt. Keys can be /regex/i.">
          {!book ? (
            <button type="button" className="btn" onClick={() => setBook({ name: "", description: "", scan_depth: null, token_budget: null, recursive_scanning: null, extensions: {}, entries: [] })}>＋ Add embedded book</button>
          ) : (
            <div>
              <div className="row">
                <input type="text" style={{ maxWidth: 240 }} placeholder="Book name" value={book.name} onChange={(e) => setBook({ ...book, name: e.target.value })} />
                <label className="row">Scan depth <input type="number" min={1} style={{ width: 80 }} value={book.scan_depth ?? ""} placeholder="4" onChange={(e) => setBook({ ...book, scan_depth: e.target.value ? Number(e.target.value) : null })} /></label>
                <label className="row">Token budget <input type="number" min={0} style={{ width: 90 }} value={book.token_budget ?? ""} placeholder="∞" onChange={(e) => setBook({ ...book, token_budget: e.target.value ? Number(e.target.value) : null })} /></label>
                <button type="button" className="btn danger sm" onClick={() => window.confirm("Remove the whole book?") && setBook(null)}>Remove book</button>
              </div>
              <div className="tok">{book.entries.length} entr{book.entries.length === 1 ? "y" : "ies"}, {book.entries.reduce((n, e) => n + tokens(e.content), 0)} token(s)</div>
              {book.entries.map((e, i) => (
                <div className="entry" key={i}>
                  <div className="row">
                    <input type="text" style={{ flex: 1, minWidth: 140 }} placeholder="Entry name" value={e.name || e.comment} onChange={(ev) => setEntry(i, { name: ev.target.value, comment: ev.target.value })} />
                    <label className="row"><input type="checkbox" checked={e.enabled} onChange={(ev) => setEntry(i, { enabled: ev.target.checked })} />On</label>
                    <label className="row"><input type="checkbox" checked={e.constant} onChange={(ev) => setEntry(i, { constant: ev.target.checked })} />Always</label>
                    <label className="row"><input type="checkbox" checked={e.selective} onChange={(ev) => setEntry(i, { selective: ev.target.checked })} />Needs 2nd key</label>
                    <button type="button" className="btn danger sm" onClick={() => setBook({ ...book, entries: book.entries.filter((_, j) => j !== i) })}>✕</button>
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    <TagInput value={e.keys} onChange={(v) => setEntry(i, { keys: v })} placeholder="Trigger keys (Enter to add)" />
                    {e.selective && <TagInput value={e.secondary_keys} onChange={(v) => setEntry(i, { secondary_keys: v })} placeholder="Secondary keys" />}
                    <textarea style={{ minHeight: 80 }} placeholder="Content inserted when triggered" value={e.content} onChange={(ev) => setEntry(i, { content: ev.target.value })} />
                    <div className="row">
                      <label className="row">Order <input type="number" style={{ width: 90 }} value={e.insertion_order} onChange={(ev) => setEntry(i, { insertion_order: Number(ev.target.value) || 0 })} /></label>
                      <select style={{ width: "auto" }} value={e.position} onChange={(ev) => setEntry(i, { position: ev.target.value })}>
                        <option value="before_char">Before description</option><option value="after_char">After scenario</option>
                      </select>
                      <span className="tok">{tk(e.content)}</span>
                    </div>
                  </div>
                </div>
              ))}
              <button type="button" className="btn sm" onClick={() => setBook({ ...book, entries: [...book.entries, { ...blankEntry(), id: book.entries.length }] })}>＋ Add entry</button>
            </div>
          )}
        </Field>
      </details>

      <div className="sticky-bar">
        <button className="btn primary" onClick={save} disabled={saving}>{saving ? "Saving…" : char ? "Save changes" : "Create Character"}</button>
        {char && <button className="btn danger" onClick={del}>Delete</button>}
        <span className="tok">{dirty ? "Unsaved changes" : ""}</span>
      </div>
    </div>
  );
}
