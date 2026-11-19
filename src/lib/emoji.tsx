import { Fragment, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { api, emojiUrl, type EmojiItem } from "../api";

/** Custom emoji and stickers, shared by every part of the app that shows or sends them. */
let items: EmojiItem[] = [];
let version = 0, loaded = false;
const subs = new Set<() => void>();
const emit = () => { version++; subs.forEach((f) => f()); };
export async function reloadEmoji() { try { items = await api.listEmoji(); loaded = true; emit(); } catch { /* none shown */ } }
export function useEmoji(): EmojiItem[] {
  useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => version);
  useEffect(() => { if (!loaded) void reloadEmoji(); }, []);
  return items;
}

/** The ones a chat in `room` can use: those that work everywhere and those tied to that room (the room's own wins where the names match). */
export function availableEmoji(all: EmojiItem[], room: number | null | undefined): EmojiItem[] {
  const out: EmojiItem[] = [];
  for (const it of all.filter((i) => i.room_id == null || (room != null && i.room_id === room))) {
    const k = out.findIndex((o) => o.kind === it.kind && o.name === it.name);
    if (k < 0) out.push(it); else if (it.room_id != null) out[k] = it;
  }
  return out;
}

export type Resolve = (kind: "emoji" | "sticker", name: string) => EmojiItem | undefined;
export const resolverFor = (all: EmojiItem[], room: number | null | undefined): Resolve => {
  const av = availableEmoji(all, room);
  return (kind, name) => av.find((i) => i.kind === kind && i.name === name);
};

const TOKEN = /(\[sticker:\s*[A-Za-z0-9_]{2,24}\s*\]|:[A-Za-z0-9_]{2,24}:)/g;

/** Turns `:name:` and `[sticker: name]` into pictures when they name something this chat has. Anything else stays as written. */
export function renderRich(text: string, resolve: Resolve | undefined): ReactNode {
  if (!resolve) return text;
  return text.split(TOKEN).map((part, i) => {
    const st = /^\[sticker:\s*([A-Za-z0-9_]{2,24})\s*\]$/.exec(part);
    if (st) { const it = resolve("sticker", st[1].toLowerCase()); if (it) return <img key={i} className="sticker" src={emojiUrl(it)} alt={`sticker: ${it.name}`} title={it.name} data-sticker={it.name} />; }
    const em = /^:([A-Za-z0-9_]{2,24}):$/.exec(part);
    if (em) { const it = resolve("emoji", em[1].toLowerCase()); if (it) return <img key={i} className="emoji" src={emojiUrl(it)} alt={`:${it.name}:`} title={`:${it.name}:`} data-emoji={it.name} />; }
    return <Fragment key={i}>{part}</Fragment>;
  });
}
