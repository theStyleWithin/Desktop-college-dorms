import { DEFAULT_ROOM_DECO, type Room } from "../api";
import { TagChip, Wreathed, plateProps } from "../lib/deco";
import { roomBackground } from "../lib/rooms";
import { useStore } from "../store";

/** A room's name the way a server shows its name: a round icon (its backdrop) with the wreath around it, the name on its nameplate, and its tag. */
export default function RoomTitle({ room, size = 26, tagOnly = false }: { room: Room; size?: number; tagOnly?: boolean }) {
  const { settings } = useStore();
  const d = room.deco ?? DEFAULT_ROOM_DECO;
  const pl = tagOnly ? { className: "" } : plateProps(d.plate, settings.deco?.animate !== false);
  if (tagOnly) return <TagChip tag={d.tag} color={d.tag_color} glyph={d.tag_glyph} />;
  const icon = <span className="room-icon" style={{ width: size, height: size, background: roomBackground(room) ?? "linear-gradient(135deg, #2a2540, #3a2f55)" }} />;
  return (
    <span className={`room-title ${pl.className}`} {...((pl as { "data-plate"?: string })["data-plate"] ? { "data-plate": (pl as { "data-plate": string })["data-plate"], "data-anim": (pl as { "data-anim"?: string })["data-anim"] } : {})} data-testid="room-title" data-room-deco={d.plate !== "none" || d.bg || d.wreath || d.tag ? "on" : undefined}>
      {d.wreath || size ? <Wreathed wreath={d.wreath} size="sm">{icon}</Wreathed> : icon}
      <span className="m-name">{room.name}</span>
      <TagChip tag={d.tag} color={d.tag_color} glyph={d.tag_glyph} />
    </span>
  );
}
