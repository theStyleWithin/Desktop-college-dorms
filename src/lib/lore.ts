import { blankEntry, type BookEntry, type CharacterBook } from "../api";

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

/**
 * Reads a lorebook file in the shapes people share: a card's embedded book (`character_book`), a SillyTavern world info
 * export (entries keyed by number, `key` / `keysecondary` / `order` / `disable`), or a bare list of entries.
 */
export function readLorebook(text: string, fallbackName: string): CharacterBook {
  let v: any;
  try { v = JSON.parse(text.replace(/^﻿/, "")); } catch { throw new Error("That file isn't valid JSON."); }
  if (v?.data?.character_book) v = v.data.character_book; // a whole V2/V3 card
  else if (v?.character_book) v = v.character_book;
  const raw = Array.isArray(v) ? v : Array.isArray(v?.entries) ? v.entries : v?.entries && typeof v.entries === "object" ? Object.values(v.entries) : null;
  if (!raw) throw new Error("No lorebook entries were found in that file.");
  const entries: BookEntry[] = raw.filter((e: any) => e && typeof e === "object").map((e: any, i: number): BookEntry => ({
    ...blankEntry(),
    keys: arr(e.keys ?? e.key),
    secondary_keys: arr(e.secondary_keys ?? e.keysecondary),
    content: String(e.content ?? ""),
    name: String(e.name ?? e.comment ?? ""),
    comment: String(e.comment ?? e.name ?? ""),
    enabled: e.enabled !== undefined ? !!e.enabled : e.disable !== undefined ? !e.disable : true,
    constant: !!e.constant,
    selective: !!e.selective,
    insertion_order: Number(e.insertion_order ?? e.order ?? 100) || 0,
    position: e.position === "after_char" || e.position === 1 ? "after_char" : "before_char",
    id: i,
  }));
  if (!entries.length) throw new Error("That lorebook has no entries.");
  return {
    name: String(v?.name ?? fallbackName), description: String(v?.description ?? ""),
    scan_depth: Number(v?.scan_depth) > 0 ? Number(v.scan_depth) : null, token_budget: Number(v?.token_budget) > 0 ? Number(v.token_budget) : null,
    recursive_scanning: typeof v?.recursive_scanning === "boolean" ? v.recursive_scanning : null, extensions: {}, entries,
  };
}

export const emptyBook = (name = ""): CharacterBook => ({ name, description: "", scan_depth: null, token_budget: null, recursive_scanning: null, extensions: {}, entries: [] });
