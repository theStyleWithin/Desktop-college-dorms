import { createContext, useContext } from "react";
import type { AppInfo, Character, Chat, Dorm, Folder, Room, SessionState, Settings } from "./api";

export type Route =
  | { page: "home" }
  | { page: "library" }
  | { page: "rooms"; edit?: number | "new" }
  | { page: "notes" }
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
