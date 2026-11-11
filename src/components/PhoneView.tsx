import { useEffect, useMemo, useRef, useState } from "react";
import type { Character, Message } from "../api";
import { displayName, mediaUrl } from "../api";
import Art from "./Art";
import { hideDirectives, textBubbles } from "../lib/rooms";

interface Live { characterId: string; text: string; continueOf: number | null; phase: string }

/**
 * The same conversation, shown as texting: a phone with message bubbles, a contact header and a typing indicator.
 * Replies written as texts (blank line between messages) arrive as separate bubbles.
 */
export default function PhoneView({ msgs, live, members, userName, busy, text, setText, send, stop, nameOf, onExit }: {
  msgs: Message[]; live: Live | null; members: Character[]; userName: string; busy: boolean;
  text: string; setText: (t: string) => void; send: () => void; stop: () => void; nameOf: (m: Message) => string; onExit: () => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setClock(new Date()), 20000); return () => clearInterval(t); }, []);
  const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const contact = members[0];
  const title = members.length > 1 ? members.map((m) => displayName(m)).join(", ") : contact ? displayName(contact) : "Messages";

  const items = useMemo(() => {
    const out: { key: string; mine: boolean; who: string; text: string; at: number; last: boolean }[] = [];
    msgs.filter((m) => m.role !== "system").forEach((m) => {
      const body = m.swipes[m.swipe_index] ?? m.swipes[m.swipes.length - 1] ?? "";
      const parts = textBubbles(m.role === "character" ? hideDirectives(body) : body);
      parts.forEach((p, i) => out.push({ key: `${m.id}-${i}`, mine: m.role === "user", who: nameOf(m), text: p, at: m.created_at, last: i === parts.length - 1 }));
    });
    return out;
  }, [msgs, nameOf]);
  const liveParts = live && live.continueOf == null ? textBubbles(hideDirectives(live.text)) : [];

  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [items.length, liveParts.length, live?.text]);

  return (
    <div className="phone-wrap" data-testid="phone">
      <div className="phone">
        <div className="phone-status"><span>{clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><span aria-hidden>▂▄▆ 5G 🔋</span></div>
        <div className="phone-head">
          <button className="btn ghost sm" onClick={onExit} aria-label="Back to chat" title="Back to the normal chat">‹</button>
          <div className="phone-ava">{contact ? <Art kind={contact.media?.kind === "vrm" ? null : contact.media?.kind ?? null} url={mediaUrl(contact)} name={title} /> : null}</div>
          <div className="grow"><b>{title}</b><div className="hint">{busy ? "typing…" : "active now"}</div></div>
        </div>
        <div className="phone-msgs">
          {items.length === 0 && !live && <div className="hint" style={{ textAlign: "center", margin: "30px 0" }}>No messages yet. Say hi 👋</div>}
          {items.map((m, i) => (
            <div key={m.key} className={`bub ${m.mine ? "me" : "them"}`} data-from={m.mine ? "me" : "them"}>
              {!m.mine && members.length > 1 && (i === 0 || items[i - 1].mine || items[i - 1].who !== m.who) && <small className="bub-who">{m.who}</small>}
              <span>{m.text}</span>
              {m.last && <small className="bub-time">{hhmm(m.at)}</small>}
            </div>
          ))}
          {liveParts.map((p, i) => <div key={`l${i}`} className="bub them">{p}</div>)}
          {live && live.continueOf == null && (liveParts.length === 0 || busy) && <div className="bub them typing" aria-label="typing"><i /><i /><i /></div>}
          <div ref={end} />
        </div>
        <div className="phone-compose">
          <input type="text" value={text} placeholder={`Text ${title}…`} aria-label="Text message"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
          {busy ? <button className="btn danger sm" onClick={stop} aria-label="Stop">■</button>
            : <button className="phone-send" onClick={send} disabled={!text.trim()} aria-label="Send text">↑</button>}
        </div>
        <small className="hint" style={{ textAlign: "center", padding: "0 0 6px" }}>{userName} · texting</small>
      </div>
    </div>
  );
}
