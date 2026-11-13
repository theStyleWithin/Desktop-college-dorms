import { createContext, useContext } from "react";
import type { AppInfo, Character, Chat, Dorm, Folder, Frame, Persona, Room, SessionState, Settings } from "./api";

export type Route =
  | { page: "home" }
  | { page: "library" }
  | { page: "rooms"; edit?: number | "new" }
  | { page: "notes" }
  | { page: "decor" }
  | { page: "lorebooks" }
  | { page: "editor"; id: string | null }
  | { page: "chat"; chatId?: number }
  | { page: "settings"; tab?: string };

export interface Store {
  characters: Character[];
  chats: Chat[];
  dorms: Dorm[];
  rooms: Room[];
  folders: Folder[];
  personas: Persona[];
  /** Who you are in chats right now: the active persona, or your plain name and profile picture. */
  me: { name: string; avatar: string | null; frame: Frame | null; persona: Persona | null };
  settings: Settings;
  info: AppInfo | null;
  modelCount: number;
  go: (r: Route) => void;
  refresh: () => Promise<void>;
  setSettings: (s: Settings) => Promise<void>;
  session: SessionState;
  setSession: (s: SessionState) => void;
}

export const StoreCtx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(StoreCtx);
