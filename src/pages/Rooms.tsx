import { useEffect, useRef, useState } from "react";
import { api, displayName, type Room, type RoomKind } from "../api";
import MusicField from "../components/MusicField";
import RoomModelField, { type ModelDraft } from "../components/RoomModelField";
import { Modal, useToast } from "../components/ui";
import { PRESETS, ROOM_KINDS, kindLabel, roomBackground } from "../lib/rooms";
import { errText } from "../lib/util";
import { useStore } from "../store";

const blank = (): Omit<Room, "id" | "created_at"> => ({ name: "", kind: "living_room", description: "", owner_kind: "self", character_id: null, backdrop: "" });

/** Makes (or opens) the room, then a dorm set in it with a first chat, and goes there. */
export async function enterRoom(room: Room, characterId: string | null, refresh: () => Promise<void>, go: (r: { page: "chat"; chatId?: number }) => void) {
  const dorm = await api.createDorm(room.name, room.id);
  const who = characterId ?? (room.owner_kind === "character" ? room.character_id : null);
  const chat = who ? await api.createChat(dorm.id, room.name, "dm", [who]) : await api.createChat(dorm.id, "general", "channel", []);
  await refresh();
  go({ page: "chat", chatId: chat.id });
}

export default function Rooms({ edit }: { edit?: number | "new" }) {
  const { rooms, dorms, characters, go, refresh } = useStore();
  const toast = useToast();
  const [starting, setStarting] = useState<Room | null>(null);
  if (edit !== undefined) return <RoomForm id={edit === "new" ? null : edit} />;

  const remove = async (r: Room) => {
    const used = dorms.filter((d) => d.room_id === r.id).length;
    if (!window.confirm(`Delete the room "${r.name}"?${used ? ` ${used} dorm(s) set in it keep their chats but lose the setting.` : ""}`)) return;
    try { await api.deleteRoom(r.id); await refresh(); } catch (e) { toast(errText(e), "err"); }
  };

  return (
    <div className="page">
      <div className="row" style={{ marginBottom: 6 }}>
        <h1 className="grow">Rooms</h1>
        <button className="btn primary" onClick={() => go({ page: "rooms", edit: "new" })}>＋ Make a room</button>
      </div>
      <p className="sub" style={{ marginBottom: 18 }}>A room is the place a dorm happens in. Characters know where they are, and the chat shows the room behind it.</p>
      {rooms.length === 0 ? (
        <div className="empty-state">
          <h3>No rooms yet</h3>
          <p className="sub" style={{ margin: "6px 0 14px" }}>Make a room first and set up a dorm in it, or add rooms later to dorms you already have.</p>
          <button className="btn primary" onClick={() => go({ page: "rooms", edit: "new" })}>＋ Make your first room</button>
        </div>
      ) : (
        <div className="room-grid">
          {rooms.map((r) => {
            const owner = characters.find((c) => c.id === r.character_id);
            const n = dorms.filter((d) => d.room_id === r.id).length;
            return (
              <div className="room-card" key={r.id}>
                <div className="room-art" style={{ background: roomBackground(r) ?? "linear-gradient(135deg, #2a2540, #3a2f55)" }} />
                <div className="room-body">
                  <h3>{r.name}</h3>
                  <div className="hint">{kindLabel(r.kind)} · {r.owner_kind === "character" && owner ? `${displayName(owner)}'s place` : "Your own space"} · {n} dorm{n === 1 ? "" : "s"}</div>
                  {r.description && <p className="sub room-desc">{r.description}</p>}
                  <div className="row" style={{ marginTop: 10 }}>
                    <button className="btn primary sm" onClick={() => setStarting(r)}>Start a dorm here</button>
                    <button className="btn sm" onClick={() => go({ page: "rooms", edit: r.id })}>Edit</button>
                    <button className="btn sm danger" onClick={() => remove(r)} aria-label={`Delete ${r.name}`}>🗑</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {starting && (
        <Modal title={`Start a dorm in ${starting.name}`} onClose={() => setStarting(null)}>
          <p className="sub">Who is there with you? You can also leave it empty and invite characters from the chat.</p>
          <StartPicker room={starting} onDone={async (cid) => { try { await enterRoom(starting, cid, refresh, go); } catch (e) { toast(errText(e), "err"); } }} />
        </Modal>
      )}
    </div>
  );
}

function StartPicker({ room, onDone }: { room: Room; onDone: (characterId: string | null) => void }) {
  const { characters } = useStore();
  const [cid, setCid] = useState<string>(room.character_id ?? "");
  return (
    <>
      <select value={cid} onChange={(e) => setCid(e.target.value)} aria-label="Character">
        <option value="">Nobody yet (just me)</option>
        {characters.map((c) => <option key={c.id} value={c.id}>{displayName(c)}</option>)}
      </select>
      <div className="row" style={{ marginTop: 14 }}><button className="btn primary" onClick={() => onDone(cid || null)}>Enter the room</button></div>
    </>
  );
}

function RoomForm({ id }: { id: number | null }) {
  const { rooms, characters, go, refresh } = useStore();
  const toast = useToast();
  const existing = id != null ? rooms.find((r) => r.id === id) ?? null : null;
  const [r, setR] = useState<Omit<Room, "id" | "created_at"> & Partial<Room>>(existing ?? blank());
  const [pick, setPick] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [music, setMusic] = useState<{ file?: File; remove?: boolean }>({});
  const [model, setModel] = useState<ModelDraft>({ scale: existing?.model_scale ?? 1, rot: existing?.model_rot ?? 0, y: existing?.model_y ?? 0, share: existing?.model_share ?? false });
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const set = (p: Partial<Room>) => setR((x) => ({ ...x, ...p }));

  const bg = pendingFile && preview ? `center / cover no-repeat url("${preview}")` : roomBackground(r as Room);
  const shelf = [...PRESETS].sort((a, b) => Number(b.shelf.includes(r.kind as RoomKind)) - Number(a.shelf.includes(r.kind as RoomKind)));

  const save = async (): Promise<Room | null> => {
    if (!r.name.trim()) { toast("Give the room a name.", "err"); return null; }
    if (r.owner_kind === "character" && !r.character_id) { toast("Pick whose place this is, or choose “My own space”.", "err"); return null; }
    setBusy(true);
    try {
      let saved: Room;
      const body = { name: r.name, kind: r.kind as RoomKind, description: r.description, owner_kind: r.owner_kind, character_id: r.owner_kind === "character" ? r.character_id : null, backdrop: pendingFile ? (existing?.backdrop.startsWith("file:") ? existing.backdrop : "") : r.backdrop };
      saved = existing ? await api.updateRoom({ ...existing, ...body }) : await api.createRoom(body);
      if (pendingFile) saved = await api.setRoomBackdrop(saved.id, pendingFile);
      if (music.file) saved = await api.setRoomMusic(saved.id, music.file);
      else if (music.remove && existing?.music) saved = await api.clearRoomMusic(saved.id);
      if (model.file) { setUpload(0); saved = await api.setRoomModel(saved.id, model.file, setUpload); saved = await api.setRoomModelCfg(saved.id, model.scale, model.rot, model.y, model.share); }
      else if (model.remove && existing?.model) saved = await api.clearRoomModel(saved.id);
      else if (existing?.model && (model.scale !== (existing.model_scale ?? 1) || model.rot !== (existing.model_rot ?? 0) || model.y !== (existing.model_y ?? 0) || model.share !== !!existing.model_share)) saved = await api.setRoomModelCfg(saved.id, model.scale, model.rot, model.y, model.share);
      return saved;
    } catch (e) { toast(errText(e), "err"); return null; } finally { setBusy(false); setUpload(null); }
  };

  return (
    <div className="page room-form">
      <button className="btn ghost sm" onClick={() => go({ page: "rooms" })}>‹ Back to Rooms</button>
      <h1 style={{ margin: "10px 0 6px" }}>{existing ? "Edit room" : "Make a room"}</h1>
      <p className="sub" style={{ marginBottom: 20 }}>Choose who the space belongs to, name it, and describe the setting. Invite characters later from chat — rooms can start solo.</p>

      <h3 className="step"><b>1</b> Who is this room for?</h3>
      <div className="row" style={{ margin: "10px 0" }}>
        <button className={`chip big ${r.owner_kind === "character" ? "on" : ""}`} onClick={() => set({ owner_kind: "character", character_id: r.character_id ?? characters[0]?.id ?? null })}>A character's place</button>
        <button className={`chip big ${r.owner_kind === "self" ? "on" : ""}`} onClick={() => set({ owner_kind: "self", character_id: null })}>My own space</button>
      </div>
      {r.owner_kind === "character" ? (
        characters.length ? (
          <select value={r.character_id ?? ""} onChange={(e) => set({ character_id: e.target.value })} aria-label="Whose place" style={{ maxWidth: 360 }}>
            {characters.map((c) => <option key={c.id} value={c.id}>{displayName(c)}</option>)}
          </select>
        ) : <div className="hint">Create a character first, or choose “My own space”.</div>
      ) : <div className="hint">Your virtual house. Live in it solo — invite characters whenever you want.</div>}

      <h3 className="step"><b>2</b> Name, description &amp; background</h3>
      <label className="field"><span>Room name</span>
        <input type="text" placeholder="e.g. My loft" value={r.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} /></label>
      <div className="field"><span>What kind of room is it?</span>
        <div className="chips">
          {ROOM_KINDS.map((k) => <button key={k.id} className={`chip big ${r.kind === k.id ? "on" : ""}`} onClick={() => set({ kind: k.id })}>{k.label}</button>)}
        </div>
        <div className="hint">Sets what the characters know they're standing in, and picks the right shelf of backdrops below.</div>
      </div>
      <label className="field"><span>Room description</span>
        <textarea rows={4} placeholder={'The setting in plain words — e.g. "Mina\'s kitchen," "living room after training"'} value={r.description} onChange={(e) => set({ description: e.target.value })} maxLength={4000} />
        <div className="hint">Worth filling in — characters can only notice what you write here. Left blank, they invent the furniture.</div></label>

      <div className="field"><span>Background</span>
        <div className="room-preview" style={{ background: bg ?? undefined }}>{!bg && <span className="hint">No backdrop yet</span>}</div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary grow" onClick={() => setPick((p) => !p)}>{pick ? "Hide backdrops" : "Choose a backdrop"}</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>Upload</button>
          {(r.backdrop || pendingFile) && <button className="btn ghost" onClick={() => { setPendingFile(null); setPreview(null); set({ backdrop: "" }); }}>Remove</button>}
          <input ref={fileRef} type="file" hidden accept="image/*" aria-label="Upload a backdrop"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { setPendingFile(f); setPreview(URL.createObjectURL(f)); setPick(false); } }} />
        </div>
        {pick && (
          <div className="preset-grid">
            {shelf.map((p) => (
              <button key={p.key} className={`preset ${r.backdrop === `preset:${p.key}` && !pendingFile ? "on" : ""}`} style={{ background: p.css }}
                onClick={() => { setPendingFile(null); setPreview(null); set({ backdrop: `preset:${p.key}` }); setPick(false); }}><span>{p.label}</span></button>
            ))}
          </div>
        )}
      </div>

      <div className="field"><span>Background music</span>
        <MusicField name={music.file ? music.file.name : music.remove ? "" : existing?.music_name ?? ""}
          onPick={(f) => setMusic({ file: f })} onRemove={() => setMusic({ remove: true })} />
        <div className="hint">Pick an MP3 (or another audio file) from your computer. It plays on a loop, quietly, whenever you are in a chat set in this room.</div>
      </div>

      <RoomModelField name={model.file ? model.file.name : existing?.model_name ?? ""} draft={model} onChange={setModel} />

      {upload != null && <div className="hint" role="status" data-testid="model-upload">Saving the 3D model… {Math.round(upload * 100)}%. Big files take a moment, please stay on this page.</div>}
      <div className="row form-actions">
        {!existing && (
          <button className="btn primary" disabled={busy} onClick={async () => {
            const room = await save(); if (!room) return;
            try { await enterRoom(room, null, refresh, go); } catch (e) { toast(errText(e), "err"); }
          }}>🏠 Create &amp; enter</button>
        )}
        <button className={`btn ${existing ? "primary" : ""}`} disabled={busy} onClick={async () => { const room = await save(); if (room) { await refresh(); go({ page: "rooms" }); } }}>{existing ? "Save" : "Save to list"}</button>
        <button className="btn ghost" onClick={() => go({ page: "rooms" })}>Cancel</button>
      </div>
    </div>
  );
}
