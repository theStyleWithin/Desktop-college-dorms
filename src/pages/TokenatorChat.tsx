import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import MicButton from "../components/MicButton";
import { PROMPT_DRAG } from "../components/PromptsMenu";
import { useToast } from "../components/ui";
import { FILE_ACCEPT, MAX_FILES, framesOf, kindOfFile } from "../lib/frames";
import { errText } from "../lib/util";
import { modelInfo, saveSees, savedSees } from "../lib/vision";
import { useStore } from "../store";

type Msg = { role: "user" | "assistant" | "note"; text: string; files?: string[]; thumbs?: string[]; sources?: string[] };
const KEY = "dorms.tokenator.chat";
const load = (): Msg[] => { try { const a = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(a) ? a.slice(-60) : []; } catch { return []; } };
const PKEY = "dorms.tokenator.personality";
type Persona = { title: string; body: string };
const loadPersona = (): Persona | null => { try { const v = JSON.parse(localStorage.getItem(PKEY) || "null"); return v && typeof v.body === "string" && v.body.trim() ? { title: String(v.title ?? "a prompt"), body: v.body } : null; } catch { return null; } };
const SUGGESTIONS = ["How do playbooks work?", "Help me plan a story idea", "How do I use a model that runs offline?", "Explain a picture I attach"];

/** The Tokenator chat: a helper that is not a character. It answers general questions and questions about the app (from the guide built into the app), takes pictures, gifs and videos if the selected model can see them, and can be spoken to. */
export default function TokenatorChat() {
  const { settings } = useStore();
  const toast = useToast();
  const info = useMemo(() => modelInfo(settings), [settings]);
  const [override, setOverride] = useState<boolean | null>(() => savedSees(info.label));
  useEffect(() => setOverride(savedSees(info.label)), [info.label]);
  const sees = info.vision === "yes" || (info.vision === "unknown" && override === true);
  const [msgs, setMsgs] = useState<Msg[]>(load);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [persona, setPersona] = useState<Persona | null>(loadPersona);
  const [over, setOver] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(msgs.slice(-60).map(({ thumbs: _t, ...m }) => m))); } catch { /* storage unavailable */ } }, [msgs]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs, busy]);

  const choose = (p: Persona | null) => {
    setPersona(p);
    try { if (p) localStorage.setItem(PKEY, JSON.stringify(p)); else localStorage.removeItem(PKEY); } catch { /* storage unavailable */ }
    setMsgs((cur) => [...cur, { role: "note", text: p ? `Personality changed to “${p.title}”. I'm still Tokenator, your helper; only my way of talking changes.` : "Back to my normal self." }]);
  };
  const isPrompt = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes(PROMPT_DRAG);
  const drop = (e: React.DragEvent) => {
    setOver(false);
    if (!isPrompt(e)) return;
    e.preventDefault();
    try { const d = JSON.parse(e.dataTransfer.getData(PROMPT_DRAG)); if (typeof d.body === "string" && d.body.trim()) choose({ title: String(d.title ?? "a prompt"), body: d.body }); } catch { toast("I couldn't read that prompt.", "err"); }
  };

  const add = (list: FileList | null) => {
    const ok: File[] = [];
    for (const f of Array.from(list ?? [])) {
      if (!kindOfFile(f)) { toast(`“${f.name}” isn't a picture, gif or video I can take.`, "err"); continue; }
      ok.push(f);
    }
    setFiles((cur) => { const all = [...cur, ...ok]; if (all.length > MAX_FILES) toast(`Up to ${MAX_FILES} files a message.`, "info"); return all.slice(0, MAX_FILES); });
  };

  const send = async (said?: string) => {
    const text = (said ?? draft).trim();
    if ((!text && !files.length) || busy) return;
    setBusy(true);
    const att = files;
    setFiles([]); setDraft("");
    const names = att.map((f) => f.name);
    const out: Msg[] = [...msgs];
    let images: string[] = [], thumbs: string[] = [], failed: string[] = [];
    const notes: string[] = [];
    if (att.length && sees) {
      for (const f of att) {
        try { const r = await framesOf(f); images.push(...r.frames); thumbs.push(r.frames[0]); notes.push(r.note); }
        catch (e) { failed.push(f.name); notes.push(`I couldn't open “${f.name}”: ${errText(e)}`); }
      }
    }
    out.push({ role: "user", text, files: names, thumbs });
    if (att.length && !sees) {
      out.push({ role: "note", text: `I can't see attached files with the model you're using (${info.label}), so I haven't looked at ${names.map((n) => `“${n}”`).join(", ")} and can't describe ${names.length === 1 ? "it" : "them"}. Sending ${names.length === 1 ? "it" : "them"} again won't change that.${info.vision === "unknown" ? " If you know this model can see pictures, switch on “This model can see pictures” below." : " To use pictures, choose a model that can see them in Settings → Models, or describe the file in words."}` });
    } else if (notes.length) out.push({ role: "note", text: notes.join(" ") });
    setMsgs(out);
    try {
      const hist = out.filter((m) => m.role !== "note").map((m, i, arr) => {
        const lastUser = i === arr.length - 1 && m.role === "user";
        const unread = lastUser && failed.length ? `\n\n[The app could not open these attached files, so you do not have them: ${failed.join(", ")}]` : "";
        return { role: m.role, text: m.text + unread, attached: m.files?.length ?? 0, images: lastUser ? images : [] };
      });
      const r = await api.tokenatorChat(hist, persona?.body ?? null);
      setMsgs((cur) => [...cur, { role: "assistant", text: r.reply, sources: r.sources }]);
    } catch (e) {
      setMsgs((cur) => [...cur, { role: "note", text: `That didn't work: ${errText(e)}` }]);
    } finally { setBusy(false); }
  };

  const status = info.vision === "yes" ? "can see pictures" : info.vision === "no" ? "can't see pictures" : sees ? "pictures switched on by you" : "can't be sure it sees pictures";
  return (
    <div className={`tchat${over ? " over" : ""}`} data-testid="tokenator-chat" onDragOver={(e) => { if (isPrompt(e)) { e.preventDefault(); setOver(true); } }} onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false); }} onDrop={drop}>
      <div className="row" style={{ gap: 10 }}>
        <h1 className="grow" style={{ margin: 0 }}>✂️ Tokenator</h1>
        <button className="btn sm" disabled={!msgs.length || busy} onClick={() => { if (window.confirm("Clear this conversation?")) setMsgs([]); }} data-testid="tchat-clear">Clear</button>
      </div>
      <p className="sub" style={{ margin: "4px 0 8px" }}>A general helper. Ask it anything, or how the app works: it looks things up in the guide built into the app, so that works offline too.</p>
      <div className="tok" data-testid="tchat-model" style={{ marginBottom: 8 }}>
        Using {info.label} · {status}
        {info.vision === "unknown" && <label className="row" style={{ display: "inline-flex", gap: 6, marginLeft: 10 }}><input type="checkbox" checked={override === true} data-testid="tchat-sees" onChange={(e) => { setOverride(e.target.checked); saveSees(info.label, e.target.checked); }} />This model can see pictures</label>}
      </div>
      <div className="tok" data-testid="tchat-persona" style={{ marginBottom: 8 }}>
        {persona
          ? <>🎭 Personality: <b>{persona.title}</b> <button className="btn ghost sm" onClick={() => choose(null)} data-testid="tchat-persona-clear">Back to normal</button></>
          : "Tip: drag a saved prompt from the Prompts menu onto this chat to give Tokenator a different personality. It stays the same helper underneath."}
      </div>
      <div className="tchat-msgs" data-testid="tchat-msgs">
        {!msgs.length && (
          <div className="empty-state" style={{ margin: "auto" }}>
            <p className="sub">What would you like help with?</p>
            <div className="chips" style={{ justifyContent: "center" }}>{SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => void send(s)}>{s}</button>)}</div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`tmsg ${m.role === "user" ? "me" : m.role}`} data-role={m.role}>
            {m.role === "note" && <b>Note from the app: </b>}
            {m.thumbs && m.thumbs.length > 0 && <div className="row" style={{ gap: 6, marginBottom: 6 }}>{m.thumbs.map((t, k) => <img key={k} src={t} alt="" style={{ height: 64, borderRadius: 8 }} />)}</div>}
            {m.files && m.files.length > 0 && <div className="tok">📎 {m.files.join(", ")}</div>}
            {m.text}
            {m.sources && m.sources.length > 0 && <div className="src" data-testid="tchat-sources">Read from the app guide: {m.sources.join(" · ")}</div>}
          </div>
        ))}
        {busy && <div className="tmsg note" data-testid="tchat-busy">Thinking…</div>}
        <div ref={end} />
      </div>
      {files.length > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap", margin: "6px 0" }} data-testid="tchat-files">
          {files.map((f, i) => <span key={i} className="chip">📎 {f.name} <button className="iconbtn" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>✕</button></span>)}
        </div>
      )}
      <div className="tchat-composer">
        <input ref={pick} type="file" hidden multiple accept={FILE_ACCEPT} aria-label="Attach files" data-testid="tchat-file" onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
        <button className="btn" title="Attach a picture, gif or video" aria-label="Attach a file" onClick={() => pick.current?.click()} disabled={busy}>📎</button>
        <textarea rows={2} value={draft} placeholder="Ask anything…  (Enter sends, Shift+Enter makes a new line)" aria-label="Message to Tokenator" data-testid="tchat-input" disabled={busy}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <MicButton disabled={busy} onText={(t, auto) => (auto ? void send(draft ? `${draft} ${t}` : t) : setDraft((d) => (d ? `${d} ${t}` : t)))} />
        <button className="btn primary" disabled={busy || (!draft.trim() && !files.length)} onClick={() => void send()} data-testid="tchat-send">Send</button>
      </div>
    </div>
  );
}
