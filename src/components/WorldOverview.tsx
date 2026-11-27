import { useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, roomPicUrl, type Lorebook, type Room, type World } from "../api";
import { Lightbox } from "./RoomGallery";
import { renderLore } from "../lib/loreText";
import { kindLabel, roomBackground } from "../lib/rooms";
import { useState, useEffect } from "react";
import { Modal } from "./ui";

/** A world to read about before diving in: its description and lore, its rooms (start a dorm in one), and the lorebooks that apply to it. */
export default function WorldOverview({ world, rooms, onClose, onStart, onEdit, onMap }: {
  world: World; rooms: Room[]; onClose: () => void; onStart: (r: Room) => void; onEdit: (r: Room) => void; onMap: () => void;
}) {
  const [books, setBooks] = useState<Lorebook[]>([]);
  const [pic, setPic] = useState<{ room: Room; id: string } | null>(null);
  useEffect(() => { api.listLorebooks().then(setBooks).catch(() => {}); }, []);
  const mine = rooms.filter((r) => r.world_id === world.id);
  const exits = mine.reduce((n, r) => n + (r.links ?? []).length, 0);
  const attached = books.filter((b) => world.lorebooks.includes(b.id));
  const lore = useMemo(() => renderLore(world.lore), [world.lore]);
  return (
    <Modal title={`🌍 ${world.name}`} onClose={onClose}>
      <div className="world-overview" data-testid="world-overview">
        {world.cover_path ? <img className="world-cover" data-testid="world-cover-view" src={convertFileSrc(world.cover_path)} alt={`${world.name}`} /> : null}
        {world.description.trim() && <p className="world-summary">{world.description}</p>}
        <div className="world-lore-read" data-testid="world-lore-read">
          {world.lore.trim() ? lore : <p className="hint">No lore written yet. Add some in the world's panel: its history, its places, its people.</p>}
        </div>
        <h4>Rooms <span className="m-count">{mine.length}</span> <small className="muted">{exits} exit{exits === 1 ? "" : "s"} between them</small></h4>
        {mine.length === 0 ? <p className="hint">No rooms in this world yet.</p> : (
          <div className="world-rooms">
            {mine.map((r) => (
              <div className="world-room" key={r.id} data-world-room={r.name}>
                <span className="room-icon" style={{ width: 44, height: 44, background: roomBackground(r) ?? "linear-gradient(135deg, #2a2540, #3a2f55)" }} />
                {(r.gallery?.length ?? 0) > 0 && <span className="thumbs">{r.gallery!.slice(0, 3).map((p) => { const u = roomPicUrl(r, p.id); return u ? <button type="button" key={p.id} aria-label={`A picture of ${r.name}`} onClick={() => setPic({ room: r, id: p.id })}><img src={u} alt={p.caption || r.name} /></button> : null; })}</span>}
                <span className="grow"><b>{r.name}</b><small>{kindLabel(r.kind)}{r.description ? ` · ${r.description.slice(0, 90)}${r.description.length > 90 ? "…" : ""}` : ""}</small></span>
                <button className="btn primary sm" onClick={() => { onClose(); onStart(r); }}>Start here</button>
                <button className="btn sm" onClick={() => { onClose(); onEdit(r); }}>Edit</button>
              </div>
            ))}
          </div>
        )}
        {attached.length > 0 && <><h4>Lorebooks that apply</h4><div className="chips">{attached.map((b) => <span className="chip" key={b.id}>📚 {b.name}</span>)}</div></>}
        {pic && <Lightbox room={pic.room} picId={pic.id} onClose={() => setPic(null)} />}
        <div className="row" style={{ marginTop: 14, gap: 8 }}>
          <button className="btn" onClick={() => { onClose(); onMap(); }}>Open the pathways editor</button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}
