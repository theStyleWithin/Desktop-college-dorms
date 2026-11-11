import { useRef } from "react";
import { api, displayName, mediaUrl } from "../api";
import Art from "../components/Art";
import { useToast } from "../components/ui";
import { errText } from "../lib/util";
import { useStore } from "../store";
import CharacterCard from "./CharacterCard";

function greeting(name: string) {
  const h = new Date().getHours();
  const part = h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return `${part}, ${name}.`;
}

export default function Home() {
  const { characters, chats, settings, modelCount, go, refresh, info } = useStore();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const byId = new Map(characters.map((c) => [c.id, c]));

  const recent = chats.slice(0, 14).map((chat) => ({ chat, c: byId.get(chat.character_ids[0]) }));
  const latest = [...characters].sort((a, b) => b.last_used - a.last_used || b.updated_at - a.updated_at).slice(0, 6);
  const noEngine = info !== null && !info.local_engine && settings.provider === "local";
  const needsModel = settings.provider === "local" && modelCount === 0 && !noEngine;

  const importFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      try {
        const r = await api.importCard(f);
        toast(`Imported ${r.character.card.name}${r.warnings.length ? ` (${r.warnings.length} notes)` : ""}`, "ok");
      } catch (e) {
        toast(`${f.name}: ${errText(e) === "NO_CARD" ? "that PNG has no character data in it" : errText(e)}`, "err");
      }
    }
    await refresh();
  };

  return (
    <div className="page">
      <div className="hero">
        <h1>{greeting(settings.user_name)}</h1>
        <p>The lights are on in the dorm. Make a character, drop in a card from anywhere, and get the hallway talking.</p>
        <div className="row">
          <button className="btn primary" onClick={() => go({ page: "editor", id: null })}>＋ New character</button>
          <button className="btn" onClick={() => file.current?.click()}>⇪ Import card</button>
          <button className="btn" onClick={() => go({ page: "chat" })}>💬 Open dorms</button>
          <input ref={file} type="file" hidden multiple accept=".json,.png,application/json,image/png"
            onChange={(e) => { importFiles(e.target.files); e.target.value = ""; }} />
        </div>
      </div>

      {noEngine && (
        <div className="banner">
          <span style={{ fontSize: "1.4rem" }}>☁️</span>
          <div className="grow">
            <b>Pick where replies come from.</b> The built-in model engine isn't available on this device yet. Use a cloud provider with your own key, or a model server on your home network.
          </div>
          <button className="btn primary" onClick={() => go({ page: "settings", tab: "models" })}>Set up</button>
        </div>
      )}
      {needsModel && (
        <div className="banner">
          <span style={{ fontSize: "1.4rem" }}>🧠</span>
          <div className="grow">
            <b>One quick step before chatting:</b> download a model. It runs on your own computer and nothing is sent anywhere.
          </div>
          <button className="btn primary" onClick={() => go({ page: "settings", tab: "models" })}>Choose a model</button>
        </div>
      )}

      {recent.length > 0 && (
        <>
          <h2>Pick up where you left off</h2>
          <div className="rail">
            {recent.map(({ chat, c }) => (
              <button key={chat.id} className="item" onClick={() => go({ page: "chat", chatId: chat.id })} title={chat.name}>
                <div className="avatar">
                  <Art kind={c?.media?.kind === "vrm" ? null : c?.media?.kind ?? null} url={c ? mediaUrl(c) : null} name={c ? displayName(c) : chat.name} frame={c?.frame} />
                </div>
                <span>{chat.name}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="row" style={{ margin: "22px 0 12px" }}>
        <h2 className="grow">Your characters</h2>
        {characters.length > 0 && <button className="btn sm" onClick={() => go({ page: "library" })}>See all {characters.length}</button>}
      </div>
      {characters.length === 0 ? (
        <div className="empty">
          <h3>No characters yet</h3>
          <p>Create one from scratch, or import a character card (PNG or JSON) from any card site or editor.</p>
        </div>
      ) : (
        <div className="grid">
          {latest.map((c) => <CharacterCard key={c.id} c={c} />)}
        </div>
      )}
    </div>
  );
}
