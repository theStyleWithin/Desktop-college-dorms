import { api, displayName, mediaUrl, tagline, type Character } from "../api";
import Art from "../components/Art";
import { Kebab, useToast } from "../components/ui";
import { errText, timeAgo, tokens } from "../lib/util";
import { useStore } from "../store";

export const cardTokens = (c: Character) =>
  tokens(c.card.description) + tokens(c.card.personality) + tokens(c.card.scenario) + tokens(c.card.first_mes) + tokens(c.card.mes_example);

export default function CharacterCard({ c }: { c: Character }) {
  const { go, refresh } = useStore();
  const toast = useToast();

  const startChat = async () => {
    try {
      const chat = await api.createChat(null, displayName(c), "dm", [c.id]);
      await refresh();
      go({ page: "chat", chatId: chat.id });
    } catch (e) { toast(errText(e), "err"); }
  };
  const exp = async (fmt: "png" | "json_v2" | "json_v3") => {
    try {
      if (await api.exportCard(c.id, fmt, c.card.name || "character")) toast("Exported", "ok");
    } catch (e) { toast(`Export failed: ${errText(e)}`, "err"); }
  };
  const del = async () => {
    if (!window.confirm(`Delete ${displayName(c)}? Chats keep their messages but lose this character.`)) return;
    await api.deleteCharacter(c.id);
    await refresh();
  };

  return (
    <div className="ccard" onClick={() => go({ page: "editor", id: c.id })}>
      <Art kind={c.media?.kind ?? null} url={mediaUrl(c)} name={displayName(c)} />
      <button className="iconbtn fav" aria-label={c.favorite ? "Unfavorite" : "Favorite"}
        onClick={(e) => { e.stopPropagation(); api.setFavorite(c.id, !c.favorite).then(refresh); }}>
        {c.favorite ? "★" : "☆"}
      </button>
      <Kebab items={[
        { label: "Chat", onClick: startChat },
        { label: "Edit", onClick: () => go({ page: "editor", id: c.id }) },
        { label: "Export as PNG card", onClick: () => exp("png") },
        { label: "Export JSON (V2, most compatible)", onClick: () => exp("json_v2") },
        { label: "Export JSON (V3)", onClick: () => exp("json_v3") },
        { label: "Delete", onClick: del, danger: true },
      ]} />
      <div className="body">
        <h3>{displayName(c)}</h3>
        <div className="tl">{tagline(c) || c.card.description.slice(0, 160) || "No description yet"}</div>
        <div className="chips">
          {c.card.tags.slice(0, 4).map((t) => <span className="chip" key={t}>{t}</span>)}
          {c.card.tags.length > 4 && <span className="chip">+{c.card.tags.length - 4}</span>}
        </div>
        <div className="meta">≈{cardTokens(c)} tokens · {c.last_used ? `chatted ${timeAgo(c.last_used)}` : `added ${timeAgo(c.created_at)}`}</div>
        <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={(e) => { e.stopPropagation(); startChat(); }}>💬 Chat</button>
      </div>
    </div>
  );
}
