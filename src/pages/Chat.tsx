import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api, displayName, mediaUrl, musicUrl, onAutoStopped, onGen, tagline, type Character, type Chat, type ChatKind, type Message, type TurnMode,
} from "../api";
import Art from "../components/Art";
import MicButton from "../components/MicButton";
import MechanicsPanel from "../components/MechanicsPanel";
import PhoneView from "../components/PhoneView";
import MusicPlayer from "../components/MusicPlayer";
import MusicField from "../components/MusicField";
import { hideDirectives, roomBackground, kindLabel } from "../lib/rooms";
import { makeWardrobe } from "../components/WardrobePanel";
import type { Speech } from "../components/SpeechBubble";
import { Modal, useToast } from "../components/ui";
import { errText, timeAgo } from "../lib/util";
import { useStore } from "../store";

interface Live { rid: string; characterId: string; text: string; phase: "loading" | "start" | "streaming"; /** set when extending an existing message */ continueOf: number | null }

const KIND_ICON: Record<ChatKind, string> = { dm: "👤", group: "👥", channel: "#" };

function renderText(text: string) {
  return text.split(/(\*[^*\n]+\*)/g).map((part, i) =>
    part.length > 2 && part.startsWith("*") && part.endsWith("*") ? <em key={i}>{part.slice(1, -1)}</em> : <Fragment key={i}>{part}</Fragment>,
  );
}

function Avatar({ c, name, pic }: { c?: Character; name: string; pic?: { src: string | null; frame: import("../api").Frame | null } }) {
  return (
    <div className="avatar">
      {pic ? <Art kind={pic.src ? "image" : null} url={pic.src} name={name} frame={pic.frame} />
        : <Art kind={c?.media?.kind === "vrm" ? null : c?.media?.kind ?? null} url={c ? mediaUrl(c) : null} name={name} frame={c?.frame} />}
    </div>
  );
}

export default function ChatPage({ initialChatId }: { initialChatId?: number }) {
  const { chats, dorms, rooms, characters, settings, go, refresh, modelCount, personas, me } = useStore();
  const toast = useToast();
  const [selected, setSelected] = useState<number | null>(initialChatId ?? chats[0]?.id ?? null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  // what the 3D character on stage is saying (a manga-style balloon above her head)
  const [speech, setSpeech] = useState<(Speech & { characterId: string }) | null>(null);
  const [text, setText] = useState("");
  const [replyAs, setReplyAs] = useState<string>("");
  const [focus, setFocus] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [modal, setModal] = useState<null | { type: "chat"; dormId: number | null } | { type: "dorm" } | { type: "who" } | { type: "mech" } | { type: "dormroom"; dormId: number }>(null);
  const [listOpen, setListOpen] = useState(false);
  const [optsOpen, setOptsOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const byId = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters]);
  const chat = chats.find((c) => c.id === selected) ?? null;
  const members = useMemo(() => (chat?.character_ids ?? []).map((i) => byId.get(i)).filter(Boolean) as Character[], [chat, byId]);
  const room = useMemo(() => { const d = dorms.find((x) => x.id === chat?.dorm_id); return d?.room_id != null ? rooms.find((r) => r.id === d.room_id) ?? null : null; }, [chat, dorms, rooms]);
  const roomBg = roomBackground(room);
  const dormOfChat = dorms.find((x) => x.id === chat?.dorm_id);
  // the dorm's own music wins over its room's
  const music = dormOfChat?.music_path ? { src: musicUrl(dormOfChat), name: dormOfChat.music_name || "Music" } : room?.music_path ? { src: musicUrl(room), name: room.music_name || "Music" } : null;
  const phone = chat?.style === "phone";
  const stageChar = (focus && byId.get(focus)) || members[0] || null;

  // load messages when switching chats
  useEffect(() => {
    setLive(null); setSpeech(null); setEditing(null); setFocus(null); setReplyAs("");
    if (selected == null) { setMsgs([]); return; }
    let alive = true;
    api.listMessages(selected).then((m) => alive && setMsgs(m));
    return () => { alive = false; };
  }, [selected]);

  // streaming events
  useEffect(() => {
    const subs = [
      onGen((e) => {
        if (e.chat_id !== selectedRef.current) { if (e.kind === "done") refresh(); return; }
        if (e.kind === "loading" || e.kind === "start") { setLive({ rid: e.request_id, characterId: e.character_id, text: "", phase: e.kind, continueOf: e.continue_of ?? null }); setSpeech({ id: e.request_id, characterId: e.character_id, text: "", streaming: true }); }
        else if (e.kind === "token") {
          setLive((l) => ({ rid: e.request_id, characterId: e.character_id, text: (l?.rid === e.request_id ? l.text : "") + e.text, phase: "streaming", continueOf: e.continue_of ?? null }));
          setSpeech((sp) => ({ id: e.request_id, characterId: e.character_id, text: (sp?.id === e.request_id ? sp.text : "") + e.text, streaming: true }));
        }
        else if (e.kind === "done") {
          setLive(null);
          setSpeech({ id: String(e.message.id) + ":" + e.message.swipe_index, characterId: e.message.character_id ?? "", text: e.message.swipes[e.message.swipe_index] ?? "", streaming: false });
          setMsgs((m) => (m.some((x) => x.id === e.message.id) ? m.map((x) => (x.id === e.message.id ? e.message : x)) : [...m, e.message]));
          refresh();
        } else if (e.kind === "error") { setLive(null); setSpeech(null); toast(e.error, "err"); }
      }),
      onAutoStopped((e) => {
        if (e.reason === "turn_limit") toast("The bots paused after reaching their turn limit. Say something to keep the conversation going.", "info");
        refresh();
      }),
    ];
    return () => { subs.forEach((p) => p.then((u) => u())); };
  }, [refresh, toast]);

  // keep the view pinned to the newest message
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 260) el.scrollTop = el.scrollHeight;
  }, [msgs, live]);
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [selected]);

  const busy = live !== null;

  const [listening, setListening] = useState(false);
  const sendText = async (raw: string) => {
    if (!chat) return;
    const t = raw.trim();
    if (busy) return;
    if (!t && chat.kind === "dm") return;
    try {
      if (t) {
        const m = await api.addUserMessage(chat.id, t);
        setMsgs((x) => [...x, m]);
        setText("");
      }
      if (chat.kind !== "channel" || replyAs || !t) await api.generate(chat.id, replyAs || null);
      else await api.generate(chat.id, null);
    } catch (e) { toast(errText(e), "err"); }
  };
  const send = () => sendText(text);
  // voice: what was said is either sent straight away or dropped into the box to check first
  const heard = (said: string, autoSend: boolean) => {
    if (autoSend && !busy) void sendText(text.trim() ? `${text.trim()} ${said}` : said);
    else setText((x) => (x.trim() ? `${x.trim()} ${said}` : said));
  };
  const stop = () => live && api.cancelGeneration(live.rid);

  const patchChat = async (patch: Partial<Chat>) => {
    if (!chat) return;
    await api.updateChat({ ...chat, ...patch });
    await refresh();
  };
  const toggleAuto = async (on: boolean) => {
    if (!chat) return;
    if (on && settings.provider === "local" && modelCount === 0) return toast("Download a model first (Settings → Models).", "err");
    await api.setAutoChat(chat.id, on);
    await refresh();
  };

  const deleteChat = async () => {
    if (!chat || !window.confirm(`Delete "${chat.name}" and all its messages?`)) return;
    await api.deleteChat(chat.id);
    await refresh();
    setSelected(chats.find((c) => c.id !== chat.id)?.id ?? null);
  };

  const saveEdit = async () => {
    if (!editing) return;
    const m = await api.editMessage(editing.id, editing.text);
    setMsgs((x) => x.map((y) => (y.id === m.id ? m : y)));
    setEditing(null);
  };
  const swipe = async (m: Message, d: number) => {
    const next = m.swipe_index + d;
    if (next < 0) return;
    if (next >= m.swipes.length) { if (!busy) await api.generate(m.chat_id, null, m.id); return; }
    const u = await api.setSwipe(m.id, next);
    setMsgs((x) => x.map((y) => (y.id === u.id ? u : y)));
  };

  const grouped = useMemo(() => {
    const map = new Map<number | null, Chat[]>();
    chats.forEach((c) => map.set(c.dorm_id, [...(map.get(c.dorm_id) ?? []), c]));
    return map;
  }, [chats]);

  const ChatItem = ({ c }: { c: Chat }) => (
    <button className={`it ${c.id === selected ? "on" : ""}`} onClick={() => { setSelected(c.id); setListOpen(false); }}>
      <span aria-hidden>{KIND_ICON[c.kind]}</span>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
      {c.auto_chat && <span title="Bots are chatting">🟢</span>}
    </button>
  );

  const nameOf = (m: Message) => (m.role === "user" ? me.name : byId.get(m.character_id ?? "")?.card.name ?? "Unknown");

  return (
    <div className="chatwrap">
      <aside className={`chatlist ${listOpen ? "open" : ""}`}>
        <div className="row" style={{ marginBottom: 6 }}>
          <button className="btn primary sm grow" onClick={() => setModal({ type: "chat", dormId: null })}>＋ New chat</button>
          <button className="btn sm" onClick={() => setModal({ type: "dorm" })} title="New dorm">＋ Dorm</button>
          {listOpen && <button className="btn sm" onClick={() => setListOpen(false)}>✕</button>}
        </div>
        {dorms.map((d) => (
          <div key={d.id}>
            <h4>
              <span>🏠 {d.name}</span>
              <span>
                <button className="btn ghost sm" title="Set this dorm in a room" aria-label={`Room for ${d.name}`} onClick={() => setModal({ type: "dormroom", dormId: d.id })}>🛋️</button>
                <button className="btn ghost sm" title="New channel in this dorm" onClick={() => setModal({ type: "chat", dormId: d.id })}>＋</button>
                <button className="btn ghost sm" title="Delete dorm" onClick={async () => { if (window.confirm(`Delete the dorm "${d.name}" and its channels?`)) { await api.deleteDorm(d.id); await refresh(); } }}>🗑</button>
              </span>
            </h4>
            {(grouped.get(d.id) ?? []).map((c) => <ChatItem key={c.id} c={c} />)}
            {!(grouped.get(d.id) ?? []).length && <div className="hint" style={{ padding: "0 10px" }}>No channels yet</div>}
          </div>
        ))}
        <h4><span>Direct &amp; group chats</span></h4>
        {(grouped.get(null) ?? []).map((c) => <ChatItem key={c.id} c={c} />)}
        {!(grouped.get(null) ?? []).length && <div className="hint" style={{ padding: "0 10px" }}>Nothing here yet</div>}
      </aside>

      <section className={`chatmain${roomBg ? " has-room" : ""}`}>
        {roomBg && <div className="room-bg" style={{ background: roomBg }} aria-hidden="true" data-room={room?.name} />}
        {!chat ? (
          <div className="page" style={{ margin: "auto", textAlign: "center" }}>
            <h2>Welcome to the dorms</h2>
            <p className="sub" style={{ margin: "8px 0 18px" }}>Start a chat with one character, a group, or a channel where they talk to each other.</p>
            {characters.length === 0
              ? <button className="btn primary" onClick={() => go({ page: "editor", id: null })}>Create your first character</button>
              : <button className="btn primary" onClick={() => setModal({ type: "chat", dormId: null })}>＋ New chat</button>}
          </div>
        ) : (
          <>
            <header className="chathead">
              <button className="btn sm only-mobile" onClick={() => setListOpen(true)} aria-label="Chats">☰</button>
              <div>
                <h3>{KIND_ICON[chat.kind]} {chat.name}</h3>
                <div className="tok">{members.map((m) => displayName(m)).join(", ") || "No characters"}{room ? <> · <button className="linklike" onClick={() => go({ page: "rooms", edit: room.id })} title={`${kindLabel(room.kind)} — edit this room`}>🛋️ {room.name}</button></> : null}</div>
              </div>
              <div className="grow" />
              {music?.src && <MusicPlayer key={music.src} src={music.src} name={music.name} />}
              <button className="btn sm only-mobile" onClick={() => setOptsOpen((o) => !o)} aria-label="Chat options" aria-expanded={optsOpen}>⋯</button>
              <div className={`chatopts ${optsOpen ? "open" : ""}`}>
              {chat.kind !== "dm" && (
                <>
                  <label className="row" title="Let the characters keep talking without you (uses more power)">
                    <input type="checkbox" checked={chat.auto_chat} onChange={(e) => toggleAuto(e.target.checked)} />
                    Bots chat on their own
                  </label>
                  {chat.auto_chat && (
                    <>
                      <select style={{ width: "auto" }} aria-label="Pace" value={chat.auto_interval_s} onChange={(e) => patchChat({ auto_interval_s: Number(e.target.value) })}>
                        {[10, 20, 30, 60, 120, 300].map((s) => <option key={s} value={s}>every {s >= 60 ? `${s / 60} min` : `${s}s`}</option>)}
                      </select>
                      <select style={{ width: "auto" }} aria-label="Stop after" value={chat.max_auto_turns} onChange={(e) => patchChat({ max_auto_turns: Number(e.target.value) })}>
                        {[4, 8, 12, 24, 50].map((n) => <option key={n} value={n}>stop after {n}</option>)}
                      </select>
                    </>
                  )}
                  <select style={{ width: "auto" }} aria-label="Turn order" value={chat.turn_mode} onChange={(e) => patchChat({ turn_mode: e.target.value as TurnMode })}>
                    <option value="round_robin">Take turns</option><option value="random">Random speaker</option><option value="mention">Reply when named</option>
                  </select>
                </>
              )}
              {personas.length > 0 && (
                <select style={{ width: "auto" }} aria-label="Playing as" title="Who you are in this roleplay" value={settings.active_persona}
                  onChange={(e) => { void api.setActivePersona(e.target.value || null).then(refresh).catch((er) => toast(errText(er), "err")); }}>
                  <option value="">Playing as {settings.user_name}</option>
                  {personas.map((p) => <option key={p.id} value={p.id}>Playing as {p.name}</option>)}
                </select>
              )}
              <button className={`btn sm ${phone ? "primary" : ""}`} aria-pressed={phone} onClick={() => patchChat({ style: phone ? "chat" : "phone" })} title="Switch between the normal chat and a texting view">📱 Phone</button>
              <button className="btn sm" onClick={() => setModal({ type: "mech" })} title="Optional story layers: affection, status, and more">🧩 Mechanics</button>
              <button className="btn sm" onClick={() => setModal({ type: "who" })}>👥 Who's here</button>
              <button className="btn sm" onClick={async () => { if (window.confirm("Clear every message in this chat?")) { await api.clearChat(chat.id); setMsgs([]); } }}>Clear</button>
              <button className="btn sm danger" onClick={deleteChat}>Delete</button>
              </div>
            </header>

            {phone ? (
              <PhoneView msgs={msgs} live={live} members={members} userName={me.name} busy={busy} text={text} setText={setText} send={send} stop={stop} nameOf={nameOf} onExit={() => patchChat({ style: "chat" })} />
            ) : (<>
            <div className="msgs" ref={scroller}>
              {msgs.length === 0 && !live && <div className="empty">{chat.kind === "channel" ? "A quiet channel. Say something, or press Next to let a character start." : "No messages yet."}</div>}
              {msgs.filter((m) => m.role !== "system").map((m, idx, arr) => {
                const c = m.character_id ? byId.get(m.character_id) : undefined;
                const isLast = idx === arr.length - 1;
                const saved = m.swipes[m.swipe_index] ?? m.swipes[m.swipes.length - 1] ?? "";
                // while a continuation streams, show it growing inside this message
                const extending = live?.continueOf === m.id;
                const body = extending ? saved + (saved && live.text && !/\s$/.test(saved) && !/^\s/.test(live.text) ? " " : "") + hideDirectives(live.text) : saved;
                return (
                  <div className={`msg ${m.role}`} key={m.id}>
                    <Avatar c={c} name={nameOf(m)} pic={m.role === "user" ? { src: me.avatar, frame: me.frame } : undefined} />
                    <div>
                      <div className="who">{nameOf(m)} <small>{timeAgo(m.created_at)}</small></div>
                      {editing?.id === m.id ? (
                        <div style={{ display: "grid", gap: 6, marginTop: 4 }}>
                          <textarea value={editing.text} onChange={(e) => setEditing({ id: m.id, text: e.target.value })} />
                          <div className="row"><button className="btn primary sm" onClick={saveEdit}>Save</button><button className="btn sm" onClick={() => setEditing(null)}>Cancel</button></div>
                        </div>
                      ) : <div className="txt">{renderText(body)}</div>}
                      {editing?.id !== m.id && (
                        <div className="tools">
                          {m.role === "character" && m.swipes.length > 1 && (
                            <>
                              <button className="btn ghost sm" disabled={m.swipe_index === 0} onClick={() => swipe(m, -1)} aria-label="Previous version">‹</button>
                              <span className="tok">{m.swipe_index + 1}/{m.swipes.length}</span>
                            </>
                          )}
                          {m.role === "character" && (isLast || m.swipes.length > 1) && (
                            <button className="btn ghost sm" disabled={busy} onClick={() => swipe(m, 1)} title={m.swipe_index + 1 >= m.swipes.length ? "Generate another version" : "Next version"} aria-label="Next version">›</button>
                          )}
                          {m.role === "character" && isLast && <button className="btn ghost sm" disabled={busy} onClick={() => api.generate(chat.id, null, m.id)}>↻ Regenerate</button>}
                          {m.role === "character" && isLast && <button className="btn ghost sm" disabled={busy} onClick={() => api.generate(chat.id, null, null, m.id)} title="Ask the character to go on and write more">⏩ Continue</button>}
                          <button className="btn ghost sm" onClick={() => setEditing({ id: m.id, text: body })}>✎ Edit</button>
                          <button className="btn ghost sm" onClick={async () => { await api.deleteMessage(m.id); setMsgs((x) => x.filter((y) => y.id !== m.id)); }}>🗑</button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {live && live.continueOf == null && (
                <div className="msg character">
                  <Avatar c={byId.get(live.characterId)} name={byId.get(live.characterId)?.card.name ?? "?"} />
                  <div>
                    <div className="who">{byId.get(live.characterId)?.card.name ?? "…"}</div>
                    {live.text ? <div className="txt">{renderText(hideDirectives(live.text))}</div>
                      : <div className="typing">{live.phase === "loading" ? "Waking up the model…" : "typing…"}</div>}
                  </div>
                </div>
              )}
            </div>

            <div className="composer">
              <div className="row">
                {chat.kind !== "dm" && members.length > 0 && (
                  <select style={{ width: "auto" }} value={replyAs} onChange={(e) => setReplyAs(e.target.value)} aria-label="Who replies">
                    <option value="">Next speaker (auto)</option>
                    {members.map((m) => <option key={m.id} value={m.id}>Reply as {displayName(m)}</option>)}
                  </select>
                )}
                <div className="grow" />
                {chat.kind !== "dm" && <button className="btn sm" disabled={busy || members.length === 0} onClick={() => api.generate(chat.id, replyAs || null)}>⏭ Next</button>}
              </div>
              <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-end" }}>
                <textarea
                  value={text} placeholder={`Message ${chat.kind === "dm" ? members[0]?.card.name ?? "" : chat.name}…`} rows={2}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
                />
                <MicButton disabled={busy} onText={heard} onListening={setListening} />
                {busy ? <button className="btn danger" onClick={stop}>■ Stop</button> : <button className="btn primary" onClick={send} disabled={!text.trim() && chat.kind === "dm"}>Send</button>}
              </div>
            </div>
            </>)}
          </>
        )}
      </section>

      <aside className="side-panel">
        {stageChar ? (
          <>
            <div className="stage"><Art key={stageChar.id + (stageChar.media?.file ?? "")} kind={stageChar.media?.kind ?? null} url={mediaUrl(stageChar)} name={displayName(stageChar)} frame={stageChar.frame} mode="full" attentive={busy || listening || text.trim().length > 0}
              wardrobe={makeWardrobe(stageChar, () => void refresh(), toast)}
              speech={speech && speech.characterId === stageChar.id ? { ...speech, text: hideDirectives(speech.text) } : null}
              talk={{ draft: text, setDraft: setText, send: (t) => void sendText(t), busy, onHeard: heard, onListening: setListening }} /></div>
            <div>
              <h3>{displayName(stageChar)}</h3>
              <div className="hint">{tagline(stageChar)}</div>
              <div className="chips" style={{ marginTop: 8 }}>{stageChar.card.tags.slice(0, 6).map((t) => <span className="chip" key={t}>{t}</span>)}</div>
              <button className="btn sm" style={{ marginTop: 10 }} onClick={() => go({ page: "editor", id: stageChar.id })}>Edit character</button>
            </div>
            {members.length > 1 && (
              <div className="who-list">
                {members.map((m) => (
                  <button key={m.id} className={m.id === stageChar.id ? "on" : ""} onClick={() => setFocus(m.id)}>
                    <Avatar c={m} name={displayName(m)} /><span>{displayName(m)}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : <div className="hint">Characters in this chat show up here.</div>}
      </aside>

      {modal?.type === "mech" && chat && <MechanicsPanel chatId={chat.id} onClose={() => setModal(null)} />}
      {modal?.type === "dormroom" && <DormRoom dormId={modal.dormId} onClose={() => setModal(null)} />}
      {modal?.type === "dorm" && <NewDorm onClose={() => setModal(null)} onDone={refresh} />}
      {modal?.type === "chat" && (
        <NewChat dormId={modal.dormId} onClose={() => setModal(null)}
          onCreated={async (c) => { await refresh(); setSelected(c.id); setModal(null); }} />
      )}
      {modal?.type === "who" && chat && (
        <Modal title="Who's in this chat" onClose={() => setModal(null)}>
          <CharacterPicker value={chat.character_ids} single={chat.kind === "dm"} onChange={(ids) => patchChat({ character_ids: ids })} />
          <p className="hint">New characters join without greeting. Say something or press Next to bring them in.</p>
        </Modal>
      )}
    </div>
  );
}

function CharacterPicker({ value, onChange, single }: { value: string[]; onChange: (v: string[]) => void; single?: boolean }) {
  const { characters } = useStore();
  if (!characters.length) return <div className="hint">Create a character first.</div>;
  return (
    <div className="who-list" style={{ maxHeight: 320, overflow: "auto" }}>
      {characters.map((c) => {
        const on = value.includes(c.id);
        return (
          <button type="button" key={c.id} className={on ? "on" : ""}
            onClick={() => onChange(single ? [c.id] : on ? value.filter((v) => v !== c.id) : [...value, c.id])}>
            <Avatar c={c} name={displayName(c)} /><span className="grow">{displayName(c)}</span><span>{on ? "✓" : ""}</span>
          </button>
        );
      })}
    </div>
  );
}

function RoomSelect({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const { rooms, go } = useStore();
  return (
    <div className="row" style={{ marginTop: 10 }}>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} aria-label="Room" style={{ flex: 1 }}>
        <option value="">No room (no setting)</option>
        {rooms.map((r) => <option key={r.id} value={r.id}>🛋️ {r.name}</option>)}
      </select>
      <button className="btn sm" onClick={() => go({ page: "rooms", edit: "new" })}>＋ New room</button>
    </div>
  );
}

function DormRoom({ dormId, onClose }: { dormId: number; onClose: () => void }) {
  const { dorms, refresh } = useStore();
  const d = dorms.find((x) => x.id === dormId);
  const [room, setRoom] = useState<number | null>(d?.room_id ?? null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Room & music for ${d?.name ?? "dorm"}`} onClose={onClose}>
      <p className="sub">The room's description tells the characters where they are, and its backdrop shows behind every chat in this dorm.</p>
      <RoomSelect value={room} onChange={setRoom} />
      <h4 style={{ margin: "18px 0 6px" }}>Background music</h4>
      <MusicField name={d?.music_name ?? ""} busy={busy}
        onPick={async (f) => { setBusy(true); try { await api.setDormMusic(dormId, f); await refresh(); } catch (e) { toast(errText(e), "err"); } finally { setBusy(false); } }}
        onRemove={async () => { setBusy(true); try { await api.clearDormMusic(dormId); await refresh(); } catch (e) { toast(errText(e), "err"); } finally { setBusy(false); } }} />
      <div className="hint">Plays on a loop in this dorm's chats. If you give the dorm its own music, it is used instead of the room's.</div>
      <div className="row" style={{ marginTop: 14 }}><button className="btn primary" onClick={async () => { await api.setDormRoom(dormId, room); await refresh(); onClose(); }}>Save</button></div>
    </Modal>
  );
}

function NewDorm({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [room, setRoom] = useState<number | null>(null);
  return (
    <Modal title="New dorm" onClose={onClose}>
      <p className="sub">A dorm is a space with its own channels, like a Discord server.</p>
      <input type="text" autoFocus placeholder="Maple Hall, 3rd floor…" value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && name.trim() && api.createDorm(name, room).then(onDone).then(onClose)} />
      <RoomSelect value={room} onChange={setRoom} />
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn primary" disabled={!name.trim()} onClick={() => api.createDorm(name, room).then(onDone).then(onClose)}>Create dorm</button>
      </div>
    </Modal>
  );
}

function NewChat({ dormId, onClose, onCreated }: { dormId: number | null; onClose: () => void; onCreated: (c: Chat) => void }) {
  const { characters, dorms } = useStore();
  const toast = useToast();
  const [kind, setKind] = useState<ChatKind>(dormId != null ? "channel" : "dm");
  const [dorm, setDorm] = useState<number | null>(dormId);
  const [ids, setIds] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [opening, setOpening] = useState(0);
  const byId = new Map(characters.map((c) => [c.id, c]));
  const auto = ids.length ? ids.map((i) => displayName(byId.get(i)!)).join(", ") : "";
  const create = useCallback(async () => {
    if (!ids.length) return toast("Pick at least one character.", "err");
    try {
      const n = name.trim() || (kind === "channel" ? "general" : auto);
      onCreated(await api.createChat(dorm, n, kind, ids, kind === "dm" ? opening : undefined));
    } catch (e) { toast(errText(e), "err"); }
  }, [ids, name, kind, dorm, auto, opening, onCreated, toast]);
  const greetings = kind === "dm" && ids[0] ? [byId.get(ids[0])?.card.first_mes ?? "", ...(byId.get(ids[0])?.card.alternate_greetings ?? [])].filter((g) => g.trim()) : [];
  return (
    <Modal title="New chat" onClose={onClose}>
      <div className="row" style={{ marginBottom: 12 }}>
        {(["dm", "group", "channel"] as ChatKind[]).map((k) => (
          <button key={k} className={`chip ${kind === k ? "on" : ""}`} onClick={() => { setKind(k); if (k === "dm") setIds(ids.slice(0, 1)); }}>
            {KIND_ICON[k]} {k === "dm" ? "One-on-one" : k === "group" ? "Group chat" : "Channel"}
          </button>
        ))}
      </div>
      <div className="hint" style={{ marginBottom: 10 }}>
        {kind === "dm" ? "Just you and one character." : kind === "group" ? "You and several characters. Greetings are posted for each." : "An empty room where characters can talk to you and each other."}
      </div>
      <CharacterPicker value={ids} single={kind === "dm"} onChange={(v) => { setIds(v); setOpening(0); }} />
      {greetings.length > 1 && (
        <label className="field-inline" style={{ display: "grid", gap: 4, marginTop: 12 }}>
          <span className="hint">Opening message ({greetings.length} to choose from; the others stay one swipe away)</span>
          <select value={opening} onChange={(e) => setOpening(Number(e.target.value))} aria-label="Opening message">
            {greetings.map((g, i) => <option key={i} value={i}>{i + 1}. {g.replace(/\s+/g, " ").slice(0, 70)}{g.length > 70 ? "…" : ""}</option>)}
          </select>
        </label>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <input type="text" style={{ flex: 1, minWidth: 160 }} placeholder={kind === "channel" ? "Channel name (general)" : auto || "Chat name"} value={name} onChange={(e) => setName(e.target.value)} />
        <select style={{ width: "auto" }} value={dorm ?? ""} onChange={(e) => setDorm(e.target.value ? Number(e.target.value) : null)} aria-label="Dorm">
          <option value="">No dorm</option>
          {dorms.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>
      <div className="row" style={{ marginTop: 14 }}><button className="btn primary" onClick={create}>Start chat</button></div>
    </Modal>
  );
}
