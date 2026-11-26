import { useSyncExternalStore } from "react";

/** The prompts the world of the chat you are looking at puts first in the Prompts menu (the chat page sets it, the menu reads it). */
export interface WorldShelf { world: string; ids: string[] }
let shelf: WorldShelf | null = null;
const subs = new Set<() => void>();
export function setWorldShelf(s: WorldShelf | null) {
  const same = (s === null && shelf === null) || (s && shelf && s.world === shelf.world && s.ids.join() === shelf.ids.join());
  if (same) return;
  shelf = s; subs.forEach((f) => f());
}
export const useWorldShelf = (): WorldShelf | null => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => shelf);
