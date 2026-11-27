import { useEffect, useRef, useState } from "react";
import { api, displayName } from "../api";
import { useStore } from "../store";
import { errText } from "../lib/util";

/**
 * Talk to a character about what you are looking at in the Gallery. They are told what it is (and, for a video, how far in you are) and, for a picture,
 * can really see it when the model can. A video's frames are never sent. The conversation is kept on this device only, per picture and character.
 */
type Msg = { role: "user" | "assistant"; text: string; saw?: boolean };
const CHAR_KEY = "dorms.gallery.chatChar", SEE_KEY = "dorms.gallery.chatSee";
const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not remembered */ } };
const histKey = (pic: string, c: string) => `dorms.gallery.chat.${pic}|${c}`;
const load = (pic: string, c: string): Msg[] => { try { const v = JSON.parse(get(histKey(pic, c)) ?? "[]"); return Array.isArray(v) ? v.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string").slice(-40) : []; } catch { return []; } };

export default function PictureChat({ pic }: { pic: { key: string; title: string; note?: string; kind: "image" | "gif" | "video" } }) {
  const { characters } = useStore();
  const sorted = [...characters].sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const [charId, setCharId] = useState<string>(() => { const s = get(CHAR_KEY); return s && characters.some((c) => c.id === s) ? s : (characters[0]?.id ?? ""); });
  const [msgs, setMsgs] = useState<Msg[]>(() => load(pic.key, charId));
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const [show, setShow] = useState(() => get(SEE_KEY) !== "0");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { setMsgs(load(pic.key, charId)); setErr(""); }, [pic.key, charId]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs.length, busy]);
  const save = (m: Msg[]) => { setMsgs(m); put(histKey(pic.key, charId), JSON.stringify(m.slice(-40))); };
  const who = characters.find((c) => c.id === charId);

  const send = async () => {
    const t = text.trim();
    if (!t || busy || !who) return;
    const next: Msg[] = [...msgs, { role: "user", text: t }];
    save(next); setText(""); setBusy(true); setErr("");
    // where a video is, so they know what moment you mean
    const v = pic.kind === "video" ? document.querySelector<HTMLVideoElement>("[data-testid=stage-vid]") : null;
    try {
      const r = await api.galleryChat(who.id, next.map((m) => ({ role: m.role, text: m.text, attached: 0, images: [] })),
        { key: pic.key, title: pic.title, note: pic.note ?? "", kind: pic.kind, at: v ? v.currentTime : null, length: v && isFinite(v.duration) ? v.duration : null }, show && pic.kind !== "video");
      save([...next, { role: "assistant", text: r.reply, saw: r.saw }]);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  if (!characters.length) return <p className="hint" data-testid="picchat-empty">You have no characters yet. Add one on the Characters page, then you can talk to them about what you are looking at.</p>;
  return (
    <div className="picchat" data-testid="picture-chat">
      <label className="field"><span>Talk to</span>
        <select value={charId} data-testid="picchat-char" aria-label="Character to talk to" onChange={(e) => { setCharId(e.target.value); put(CHAR_KEY, e.target.value); }}>
          {sorted.map((c) => <option key={c.id} value={c.id}>{displayName(c)}</option>)}
        </select></label>
      {pic.kind === "video"
        ? <div className="hint">{who ? displayName(who) : "They"} can't see a video, only its name and where you are in it. Tell them what you're watching.</div>
        : <label className="check" style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={show} data-testid="picchat-see" onChange={(e) => { setShow(e.target.checked); put(SEE_KEY, e.target.checked ? "1" : "0"); }} /> Let them see this picture <small className="muted">(needs a model that can see pictures)</small></label>}
      <div className="picchat-log" data-testid="picchat-log" aria-live="polite">
        {!msgs.length ? <p className="hint">Say something about what you're looking at.</p> : null}
        {msgs.map((m, i) => (
          <div key={i} className={`picchat-msg ${m.role}`} data-role={m.role}>
            <b>{m.role === "user" ? "You" : displayName(who!)}</b>
            <span>{m.text}</span>
            {m.role === "assistant" && m.saw === false && !(pic.kind === "video") && show ? <small className="muted"> (they couldn't see the picture: this model may not handle pictures)</small> : null}
          </div>
        ))}
        {busy ? <div className="picchat-msg assistant" data-testid="picchat-busy"><i>{who ? displayName(who) : "They"} is thinking…</i></div> : null}
        <div ref={end} />
      </div>
      {err ? <div className="banner" role="alert" data-testid="picchat-error">{err}</div> : null}
      <textarea value={text} rows={3} placeholder={`Tell ${who ? displayName(who) : "them"} what you think…`} aria-label="Message" data-testid="picchat-input" onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); void send(); } else if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); void send(); } }} />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={busy || !text.trim()} data-testid="picchat-send" onClick={() => void send()}>{busy ? "…" : "Send"}</button>
        <small className="muted">Enter sends, Shift+Enter makes a new line</small>
        {msgs.length ? <button className="btn ghost sm" data-testid="picchat-clear" style={{ marginLeft: "auto" }} onClick={() => { if (window.confirm("Clear this conversation?")) save([]); }}>Clear</button> : null}
      </div>
    </div>
  );
}
