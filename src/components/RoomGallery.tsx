import { useRef, useState } from "react";
import { api, roomPicUrl, type Room } from "../api";
import { errText } from "../lib/util";
import { useStore } from "../store";
import { Modal, useToast } from "./ui";

/** A picture shown large, with its caption. */
export function Lightbox({ room, picId, onClose }: { room: Room; picId: string; onClose: () => void }) {
  const pic = room.gallery?.find((p) => p.id === picId);
  const url = pic ? roomPicUrl(room, picId) : null;
  if (!pic || !url) return null;
  const all = room.gallery ?? [];
  const [cur, setCur] = useState(all.findIndex((p) => p.id === picId));
  const it = all[cur] ?? pic;
  return (
    <Modal title={room.name} onClose={onClose}>
      <div className="lightbox" data-testid="lightbox">
        <img src={roomPicUrl(room, it.id) ?? url} alt={it.caption || room.name} style={{ maxWidth: "100%", maxHeight: "65vh", display: "block", margin: "0 auto", borderRadius: 10 }} />
        {it.caption && <p className="hint" style={{ textAlign: "center" }}>{it.caption}</p>}
        {all.length > 1 && <div className="row" style={{ justifyContent: "center", gap: 10 }}>
          <button className="btn" onClick={() => setCur((cur - 1 + all.length) % all.length)} aria-label="Previous picture">‹</button>
          <span className="tok">{cur + 1} of {all.length}</span>
          <button className="btn" onClick={() => setCur((cur + 1) % all.length)} aria-label="Next picture">›</button>
        </div>}
      </div>
    </Modal>
  );
}

/** A room's gallery: pictures that show what the place looks like, each with a caption the characters are told too. */
export default function RoomGallery({ room }: { room: Room | null }) {
  const { refresh } = useStore();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  if (!room) return <div className="hint">Save the room first, then you can add pictures of it.</div>;
  const pics = room.gallery ?? [];
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await refresh(); } catch (e) { toast(errText(e), "err"); } finally { setBusy(false); } };
  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    await run(async () => { for (const f of Array.from(files)) { try { await api.addRoomPicture(room.id, f, ""); } catch (e) { toast(`${f.name}: ${errText(e)}`, "err"); } } });
  };
  return (
    <div className="room-gallery" data-testid="room-gallery">
      <div className="room-gallery-grid">
        {pics.map((p) => {
          const url = roomPicUrl(room, p.id);
          return (
            <div className="room-pic" key={p.id} data-pic={p.id}>
              {url ? <button type="button" className="room-pic-img" aria-label="Show this picture large" onClick={() => setOpen(p.id)}><img src={url} alt={p.caption || room.name} /></button> : null}
              <input type="text" defaultValue={p.caption} maxLength={120} placeholder="Caption: what it shows" aria-label="Caption" data-testid="room-pic-caption"
                onBlur={(e) => { if (e.target.value !== p.caption) void run(() => api.setRoomPictureCaption(room.id, p.id, e.target.value)); }} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
              <div className="row" style={{ gap: 6 }}>
                <button type="button" className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.useRoomPictureAsBackdrop(room.id, p.id); toast("Now the room's backdrop.", "ok"); })}>Use as backdrop</button>
                <button type="button" className="btn sm danger" disabled={busy} aria-label="Remove this picture" onClick={() => void run(() => api.removeRoomPicture(room.id, p.id))}>🗑</button>
              </div>
            </div>
          );
        })}
        <button type="button" className="room-pic add" disabled={busy || pics.length >= 24} data-testid="room-pic-add" onClick={() => input.current?.click()}>＋ Add pictures<small>{pics.length} of 24</small></button>
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden data-testid="room-pic-file" onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
      <div className="hint">Pictures that show the place: its look, its mood, its corners. A caption is also told to the characters as a detail of the room, so words like "a cracked blue teapot on the sill" work as well as a good description. The pictures are copied into the app.</div>
      {open && <Lightbox room={room} picId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
