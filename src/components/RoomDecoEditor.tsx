import { DEFAULT_DECO, DEFAULT_ROOM_DECO, type Room, type RoomDeco } from "../api";
import { roomBackground } from "../lib/rooms";
import { useStore } from "../store";
import { TagFields } from "./DecoTab";
import DecoPicker from "./DecoPicker";
import RoomTitle from "./RoomTitle";

/** A room's optional decorations and tag, like a server's. The same nameplates, backgrounds and wreaths a profile can wear, and a short tag beside the name. */
export default function RoomDecoEditor({ room, value, onChange }: { room: Room; value: RoomDeco; onChange: (d: RoomDeco) => void }) {
  const { settings } = useStore();
  const mine = settings.deco ?? DEFAULT_DECO;
  const bgStyle = roomBackground(room) ?? "linear-gradient(135deg, #2a2540, #3a2f55)";
  const avatar = (size: number) => <span className="room-icon" style={{ width: size, height: size, background: bgStyle }} />;
  const set = (p: Partial<RoomDeco>) => onChange({ ...value, ...p });
  const same = () => onChange({ plate: mine.plate, bg: mine.bg, wreath: mine.wreath, tag: mine.tag, tag_color: mine.tag_color, tag_glyph: mine.tag_glyph });
  const bare = JSON.stringify(value) === JSON.stringify(DEFAULT_ROOM_DECO);
  return (
    <div className="room-deco" data-testid="room-deco">
      <div className="row" style={{ gap: 10, flexWrap: "wrap", margin: "6px 0 10px" }}>
        <RoomTitle room={{ ...room, deco: value }} size={30} />
        <button type="button" className="btn" data-testid="room-deco-same" onClick={same} title="Give the room the nameplate, background, wreath and tag you wear">Same as my profile</button>
        {!bare && <button type="button" className="btn" onClick={() => onChange({ ...DEFAULT_ROOM_DECO })}>Take it all off</button>}
      </div>
      <details className="room-deco-tag" open={!!value.tag}>
        <summary>Room tag</summary>
        <TagFields value={value} onChange={(p) => set(p)} />
      </details>
      <DecoPicker value={{ plate: value.plate, bg: value.bg, wreath: value.wreath }} animate={settings.deco?.animate !== false} avatar={avatar} name={room.name || "Your room"} onChange={(p) => set(p)} />
    </div>
  );
}
