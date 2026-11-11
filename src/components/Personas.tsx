import { useRef, useState } from "react";
import { api, personaAvatar, profileAvatar, type Frame, type Persona } from "../api";
import FrameEditor from "./FrameEditor";
import { ProfileAvatar } from "./ProfileForms";
import { Modal, useToast } from "./ui";
import { errText } from "../lib/util";
import { useStore } from "../store";

const PIC_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp";

/** Your profile picture (PNG, JPG or an animated GIF), with the same position-and-zoom window as character pictures. */
export function ProfilePicture() {
  const { session, setSession } = useStore();
  const toast = useToast();
  const p = session.profile;
  const file = useRef<HTMLInputElement>(null);
  const [framing, setFraming] = useState<{ file?: File; url: string } | null>(null);
  const src = profileAvatar(p);
  const reload = async () => setSession(await api.session());
  if (!p) return <div className="hint">Profile pictures belong to profiles. Make this a real profile to add one, or give a persona its own picture.</div>;
  return (
    <>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn sm" onClick={() => file.current?.click()}>🖼 {src ? "Change picture" : "Add a picture"}</button>
        {src && <button className="btn sm" onClick={() => setFraming({ url: src })}>⤧ Position</button>}
        {src && <button className="btn sm" onClick={() => api.clearProfileAvatar().then(reload).catch((e) => toast(errText(e), "err"))}>Remove</button>}
        <input ref={file} type="file" hidden accept={PIC_ACCEPT} aria-label="Profile picture" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) setFraming({ file: f, url: URL.createObjectURL(f) }); }} />
      </div>
      {framing && (
        <FrameEditor title="Position your picture" src={framing.url} initial={framing.file ? null : p.avatar_frame}
          onClose={() => { if (framing.file) URL.revokeObjectURL(framing.url); setFraming(null); }}
          onSave={async (fr) => {
            const cur = framing; setFraming(null);
            try { if (cur.file) { await api.setProfileAvatar(cur.file); URL.revokeObjectURL(cur.url); } await api.setProfileAvatarFrame(fr); await reload(); toast("Picture saved", "ok"); } catch (e) { toast(errText(e), "err"); }
          }} />
      )}
    </>
  );
}

function PersonaForm({ persona, onClose, onSaved }: { persona: Persona | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [name, setName] = useState(persona?.name ?? "");
  const [description, setDescription] = useState(persona?.description ?? "");
  const [style, setStyle] = useState(persona?.style ?? "");
  const [pic, setPic] = useState<{ file?: File; url: string | null; frame: Frame | null; removed?: boolean }>({ url: persona ? personaAvatar(persona) : null, frame: persona?.frame ?? null });
  const [framing, setFraming] = useState<{ file?: File; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const save = async () => {
    setBusy(true);
    try {
      let p = await api.savePersona({ id: persona?.id, name, description, style });
      if (pic.removed && !pic.file && persona?.avatar) p = await api.clearPersonaAvatar(p.id);
      if (pic.file) { p = await api.setPersonaAvatar(p.id, pic.file); }
      if (pic.file || (persona && pic.frame !== persona.frame && !pic.removed)) p = await api.setPersonaFrame(p.id, pic.frame);
      await onSaved(); onClose();
    } catch (e) { toast(errText(e), "err"); setBusy(false); }
  };
  return (
    <Modal title={persona ? "Edit persona" : "New persona"} onClose={onClose} wide>
      <div className="row" style={{ alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 8, justifyItems: "center" }}>
          <ProfileAvatar name={name || "?"} size={96} src={pic.url} frame={pic.frame} />
          <button type="button" className="btn sm" onClick={() => file.current?.click()}>{pic.url ? "Change" : "Add picture"}</button>
          {pic.url && <button type="button" className="btn sm" onClick={() => setFraming({ url: pic.url!, file: undefined })}>⤧ Position</button>}
          {pic.url && <button type="button" className="btn ghost sm" onClick={() => setPic({ url: null, frame: null, removed: true })}>Remove</button>}
          <input ref={file} type="file" hidden accept={PIC_ACCEPT} aria-label="Persona picture" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) setFraming({ file: f, url: URL.createObjectURL(f) }); }} />
        </div>
        <div style={{ display: "grid", gap: 10, flex: 1, minWidth: 260 }}>
          <label className="f2"><span>Name <small className="hint">(what the characters call you)</small></span>
            <input type="text" value={name} maxLength={60} placeholder="e.g. Kai the transfer student" aria-label="Persona name" onChange={(e) => setName(e.target.value)} /></label>
          <label className="f2"><span>Who you are <small className="hint">(looks, background, personality)</small></span>
            <textarea rows={5} value={description} placeholder="A second-year art student who talks too fast when nervous…" aria-label="Persona description" onChange={(e) => setDescription(e.target.value)} /></label>
          <label className="f2"><span>How you want to roleplay, and what to remember</span>
            <textarea rows={5} value={style} placeholder="Slow-burn friendship, no sudden time skips, keep descriptions short. Remember I'm allergic to cats and my sister is called Mei." aria-label="Roleplay preferences" onChange={(e) => setStyle(e.target.value)} /></label>
        </div>
      </div>
      <div className="hint" style={{ margin: "10px 0" }}>When this persona is active, all of this is sent to the AI at the start of every reply, so it knows who you are and how you like to play.</div>
      <div className="row"><button className="btn primary" disabled={busy || !name.trim()} onClick={() => void save()}>Save persona</button><button className="btn ghost" onClick={onClose}>Cancel</button></div>
      {framing && (
        <FrameEditor title="Position the picture" src={framing.url} initial={framing.file ? null : pic.frame}
          onClose={() => { if (framing.file) URL.revokeObjectURL(framing.url); setFraming(null); }}
          onSave={(fr) => { const f = framing; setFraming(null); setPic(f.file ? { file: f.file, url: f.url, frame: fr } : { ...pic, frame: fr }); }} />
      )}
    </Modal>
  );
}

/** Settings → Personas: the people you can be in a chat. The active one is described to the AI before each reply. */
export function PersonasTab() {
  const { personas, settings, me, refresh, go } = useStore();
  const toast = useToast();
  const [editing, setEditing] = useState<Persona | "new" | null>(null);
  const activate = async (id: string | null) => { try { await api.setActivePersona(id); await refresh(); } catch (e) { toast(errText(e), "err"); } };
  const remove = async (p: Persona) => {
    if (!window.confirm(`Delete the persona "${p.name}"?`)) return;
    try { await api.deletePersona(p.id); await refresh(); } catch (e) { toast(errText(e), "err"); }
  };
  const plainActive = !personas.some((p) => p.id === settings.active_persona);
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Personas</h3>
        <p className="sub" style={{ margin: "4px 0 0" }}>
          A persona is who you are in a roleplay: a name, a picture, who you are, and how you like to play. Make as many as you like and switch any time, also from inside a chat.
          The <b>active</b> persona is sent to the AI before it replies, so it knows who you are and what to remember.
        </p>
      </div>
      <div className="persona-grid">
        <div className={`persona-card ${plainActive ? "on" : ""}`} data-persona="default">
          <div className="row" style={{ gap: 10 }}>
            <ProfileAvatar name={settings.user_name || "You"} size={48} src={me.persona ? null : me.avatar} frame={me.persona ? null : me.frame} />
            <div className="grow"><b>{settings.user_name || "You"}</b><div className="hint">Default: your name and “about you” from the Chat tab</div></div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            {plainActive ? <span className="chip on">Active</span> : <button className="btn sm" onClick={() => void activate(null)}>Use this</button>}
            <button className="btn ghost sm" onClick={() => go({ page: "settings", tab: "chat" })}>Edit in Chat settings</button>
          </div>
        </div>
        {personas.map((p) => {
          const on = settings.active_persona === p.id;
          return (
            <div className={`persona-card ${on ? "on" : ""}`} key={p.id} data-persona={p.name}>
              <div className="row" style={{ gap: 10 }}>
                <ProfileAvatar name={p.name} size={48} src={personaAvatar(p)} frame={p.frame} />
                <div className="grow" style={{ minWidth: 0 }}><b>{p.name}</b><div className="hint persona-desc">{p.description || p.style || "No description yet"}</div></div>
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                {on ? <span className="chip on">Active</span> : <button className="btn sm" onClick={() => void activate(p.id)}>Use this persona</button>}
                <button className="btn sm" onClick={() => setEditing(p)}>Edit</button>
                <button className="btn ghost sm" onClick={() => void remove(p)} aria-label={`Delete ${p.name}`}>🗑</button>
              </div>
            </div>
          );
        })}
      </div>
      <div><button className="btn primary" onClick={() => setEditing("new")}>＋ New persona</button></div>
      {editing && <PersonaForm persona={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  );
}
