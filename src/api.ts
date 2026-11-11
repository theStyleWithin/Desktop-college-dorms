import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { stat, writeFile } from "@tauri-apps/plugin-fs";

export type MediaKind = "image" | "gif" | "video" | "vrm";
export interface Media { kind: MediaKind; file: string }

export interface BookEntry {
  keys: string[];
  content: string;
  extensions: Record<string, unknown>;
  enabled: boolean;
  insertion_order: number;
  case_sensitive: boolean | null;
  name: string;
  priority: number | null;
  id: number | null;
  comment: string;
  selective: boolean;
  secondary_keys: string[];
  constant: boolean;
  position: string;
  [k: string]: unknown;
}

export interface CharacterBook {
  name: string;
  description: string;
  scan_depth: number | null;
  token_budget: number | null;
  recursive_scanning: boolean | null;
  extensions: Record<string, unknown>;
  entries: BookEntry[];
  [k: string]: unknown;
}

export interface CardData {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  character_book: CharacterBook | null;
  tags: string[];
  creator: string;
  character_version: string;
  nickname: string;
  group_only_greetings: string[];
  extensions: Record<string, any>;
  [k: string]: unknown;
}

/** How a picture is framed: the point of it to keep in view (0..1 across and down) and the zoom. */
export interface Frame { x: number; y: number; zoom: number }
export const DEFAULT_FRAME: Frame = { x: 0.5, y: 0.5, zoom: 1 };
export interface Lorebook { id: string; name: string; book: CharacterBook; created_at: number; updated_at: number }
export interface Folder { id: string; name: string; cover: string | null; frame: Frame | null; created_at: number; cover_path?: string | null }

export interface Character {
  id: string;
  card: CardData;
  media: Media | null;
  /** What to show right now: the outfit being worn, or the original model. */
  media_path: string | null;
  /** The wardrobe (3D characters): extra outfit models, and which one is on (null = the original). */
  outfits?: { id: string; name: string; file: string }[];
  outfit?: string | null;
  outfit_paths?: { id: string; name: string; path: string }[];
  /** How the picture is framed so a face is never cut off. */
  frame?: Frame | null;
  /** The folder this character is filed in (null = top level). */
  folder?: string | null;
  /** Library lorebooks attached to this character (besides the book inside the card). */
  lorebooks?: string[];
  favorite: boolean;
  created_at: number;
  updated_at: number;
  last_used: number;
  /** The card's own system prompt may take priority only when trusted (imported cards start untrusted). */
  trusted: boolean;
}

export interface Dorm { id: number; name: string; created_at: number; room_id?: number | null; music?: string; music_name?: string; music_path?: string | null }

export type RoomKind = "living_room" | "bedroom" | "kitchen" | "bathroom" | "dining_room" | "games_room" | "office" | "garage" | "garden" | "balcony" | "basement" | "rooftop" | "other";
export interface Room {
  id: number; name: string; kind: RoomKind; description: string;
  owner_kind: "character" | "self"; character_id: string | null;
  /** "" | "preset:<key>" | "file:<path>" */
  backdrop: string; created_at: number;
  /** absolute path of an uploaded backdrop (use roomBackdrop() to turn it into something drawable) */
  backdrop_path?: string | null;
  /** background music: the file's original name, and where it is (use musicUrl()) */
  music?: string; music_name?: string; music_path?: string | null;
}

export interface Note { id: string; title: string; body: string; pinned: boolean; created_at: number; updated_at: number }

export interface MechanicVar { id: string; name: string; kind: string; min: number | null; max: number | null; description: string }
export interface MechanicPack {
  id: string; name: string; description: string; tags: string[];
  /** which built-in panel shows it */
  app: "relations" | "status" | "phone" | "vars";
  variables: MechanicVar[]; entries: number; reactions: number; has_ui: boolean;
}
export interface ChatMechanic { mech_id: string; enabled: boolean; state: Record<string, any> }
export type ChatKind = "dm" | "group" | "channel";
export type TurnMode = "round_robin" | "random" | "mention";
export interface Chat {
  id: number;
  dorm_id: number | null;
  name: string;
  kind: ChatKind;
  character_ids: string[];
  auto_chat: boolean;
  auto_interval_s: number;
  turn_mode: TurnMode;
  max_auto_turns: number;
  created_at: number;
  updated_at: number;
  /** chat | phone (shown and written as texting) */
  style?: "chat" | "phone";
}
export interface Message {
  id: number;
  chat_id: number;
  role: "user" | "character" | "system";
  character_id: string | null;
  swipes: string[];
  swipe_index: number;
  created_at: number;
}

export interface HeaderPair { name: string; value: string }
export interface ApiProfile {
  id: string;
  name: string;
  format: "openai" | "anthropic";
  base_url: string;
  model: string;
  chat_path: string;
  auth: "bearer" | "x-api-key" | "header" | "none";
  auth_header: string;
  headers: HeaderPair[];
  extra_body: string;
}
export const newProfile = (): ApiProfile => ({
  id: crypto.randomUUID(), name: "My API", format: "openai", base_url: "", model: "", chat_path: "/chat/completions",
  auth: "bearer", auth_header: "", headers: [], extra_body: "",
});

export interface Settings {
  /** local | openai | anthropic | custom:<profile id> */
  provider: string;
  profiles: ApiProfile[];
  user_name: string;
  user_description: string;
  context_tokens: number;
  max_tokens: number;
  temperature: number;
  top_p: number;
  local_model: string;
  local_gpu: boolean;
  openai_base_url: string;
  openai_model: string;
  anthropic_model: string;
  use_card_system_prompt: boolean;
  default_system: string;
  theme: string;
  /** Voice input: an OpenAI-compatible /audio/transcriptions server. */
  stt_url: string;
  stt_model: string;
  stt_language: string;
  stt_auto_send: boolean;
}

export interface Preset { id: string; label: string; blurb: string; file: string; url: string; size_gb: number; min_ram_gb: number }
export interface Hardware { total_ram_gb: number; recommended: string; presets: Preset[]; engine_available: boolean }
export interface ModelFile { file: string; size: number }
export interface EngineStatus { running: boolean; model: string; backend: string }
export interface AppInfo { version: string; data_dir: string; portable: boolean; platform: string; local_engine: boolean }
export interface ImportResult { character: Character; warnings: string[]; spec: string }

export interface ProfileInfo { id: string; handle: string; display_name: string; has_passcode: boolean; created_at: number; last_login: number }
export interface SessionState {
  signed_in: boolean;
  guest: boolean;
  profile: ProfileInfo | null;
  profiles: ProfileInfo[];
  ask_on_launch: boolean;
  /** Characters, dorms and chats already in the guest space. */
  guest_items: number;
}
export interface ExportInfo { token: string; file_name: string; size: number; characters: number; dorms: number; chats: number; messages: number; media: number }
export interface ImportPreview {
  handle: string; display_name: string; guest: boolean; app_version: string; exported_at: number;
  characters: number; dorms: number; chats: number; messages: number; media: number;
  already_here: boolean; handle_taken: boolean;
}

export type GenEvent =
  | { kind: "loading" | "start"; request_id: string; chat_id: number; character_id: string; continue_of?: number | null }
  | { kind: "token"; request_id: string; chat_id: number; character_id: string; text: string; continue_of?: number | null }
  | { kind: "done"; request_id: string; chat_id: number; character_id: string; message: Message; continue_of?: number | null }
  | { kind: "error"; request_id: string; chat_id: number; error: string };

export interface ModelProgress { file: string; downloaded: number; total: number; done: boolean; error: string | null }

const enc = (s: string) => encodeURIComponent(s);
const bin = (cmd: string, bytes: Uint8Array, headers: Record<string, string>) =>
  invoke<any>(cmd, bytes, { headers });

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  // characters
  listCharacters: () => invoke<Character[]>("list_characters"),
  getCharacter: (id: string) => invoke<Character | null>("get_character", { id }),
  saveCharacter: (character: Partial<Character> & { card: CardData }) =>
    invoke<Character>("save_character", { character }),
  deleteCharacter: (id: string) => invoke<void>("delete_character", { id }),
  setFavorite: (id: string, favorite: boolean) => invoke<void>("set_favorite", { id, favorite }),
  /** Sends a WAV recording to the voice server from Settings → Voice and returns what was said. */
  transcribe: (wav: Uint8Array) => bin("transcribe_audio", wav, {}) as Promise<string>,
  testVoice: () => invoke<string>("test_voice"),
  async setMedia(id: string, file: File): Promise<Character> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return bin("set_media", bytes, { "x-char-id": id, "x-file-name": enc(file.name) });
  },
  async addOutfit(id: string, file: File, name?: string): Promise<Character> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return bin("add_outfit", bytes, { "x-char-id": id, "x-file-name": enc(file.name), "x-outfit-name": enc(name ?? "") });
  },
  setOutfit: (id: string, outfitId: string | null) => invoke<Character>("set_outfit", { id, outfitId }),
  renameOutfit: (id: string, outfitId: string, name: string) => invoke<Character>("rename_outfit", { id, outfitId, name }),
  removeOutfit: (id: string, outfitId: string) => invoke<Character>("remove_outfit", { id, outfitId }),
  clearMedia: (id: string) => invoke<Character>("clear_media", { id }),
  async importCard(file: File): Promise<ImportResult> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return bin("import_card", bytes, { "x-file-name": enc(file.name) });
  },
  async exportCard(id: string, format: "png" | "json_v2" | "json_v3", suggestedName: string) {
    const buf = await invoke<ArrayBuffer>("export_card", { id, format });
    const ext = format === "png" ? "png" : "json";
    const safe = suggestedName.replace(/[\\/:*?"<>|]+/g, "_") || "character";
    const path = await save({
      defaultPath: `${safe}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!path) return false;
    await writeFile(path, new Uint8Array(buf));
    return true;
  },
  // dorms & chats
  listDorms: () => invoke<Dorm[]>("list_dorms"),
  createDorm: (name: string, roomId: number | null = null) => invoke<Dorm>("create_dorm", { name, roomId }),
  setDormRoom: (id: number, roomId: number | null) => invoke<void>("set_dorm_room", { id, roomId }),
  setFrame: (id: string, frame: Frame | null) => invoke<Character>("set_frame", { id, frame }),
  // folders
  listFolders: () => invoke<Folder[]>("list_folders"),
  createFolder: (name: string) => invoke<Folder>("create_folder", { name }),
  renameFolder: (id: string, name: string) => invoke<Folder>("rename_folder", { id, name }),
  deleteFolder: (id: string) => invoke<void>("delete_folder", { id }),
  async setFolderCover(id: string, file: File): Promise<Folder> {
    return bin("set_folder_cover", new Uint8Array(await file.arrayBuffer()), { "x-folder-id": id, "x-file-name": enc(file.name) });
  },
  setFolderFrame: (id: string, frame: Frame | null) => invoke<Folder>("set_folder_frame", { id, frame }),
  clearFolderCover: (id: string) => invoke<Folder>("clear_folder_cover", { id }),
  moveCharacters: (ids: string[], folder: string | null) => invoke<void>("move_characters", { ids, folder }),
  // lorebooks
  listLorebooks: () => invoke<Lorebook[]>("list_lorebooks"),
  saveLorebook: (b: { id?: string; name: string; book: CharacterBook }) => invoke<Lorebook>("save_lorebook", { lorebook: { id: "", created_at: 0, updated_at: 0, ...b } }),
  deleteLorebook: (id: string) => invoke<void>("delete_lorebook", { id }),
  // notes
  listNotes: () => invoke<Note[]>("list_notes"),
  saveNote: (note: Pick<Note, "title" | "body" | "pinned"> & { id?: string }) => invoke<Note>("save_note", { note: { id: "", created_at: 0, updated_at: 0, ...note } }),
  deleteNote: (id: string) => invoke<void>("delete_note", { id }),
  // background music
  async setRoomMusic(id: number, file: File): Promise<Room> {
    return bin("set_room_music", new Uint8Array(await file.arrayBuffer()), { "x-room-id": String(id), "x-file-name": enc(file.name) });
  },
  clearRoomMusic: (id: number) => invoke<Room>("clear_room_music", { id }),
  async setDormMusic(id: number, file: File): Promise<Dorm> {
    return bin("set_dorm_music", new Uint8Array(await file.arrayBuffer()), { "x-dorm-id": String(id), "x-file-name": enc(file.name) });
  },
  clearDormMusic: (id: number) => invoke<Dorm>("clear_dorm_music", { id }),
  // rooms
  listRooms: () => invoke<Room[]>("list_rooms"),
  createRoom: (room: Omit<Room, "id" | "created_at" | "backdrop_path">) => invoke<Room>("create_room", { room: { ...room, id: 0, created_at: 0 } }),
  updateRoom: (room: Room) => invoke<Room>("update_room", { room }),
  deleteRoom: (id: number) => invoke<void>("delete_room", { id }),
  async setRoomBackdrop(id: number, file: File): Promise<Room> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return bin("set_room_backdrop", bytes, { "x-room-id": String(id), "x-file-name": enc(file.name) });
  },
  // mechanic packs
  listMechanics: () => invoke<MechanicPack[]>("list_mechanics"),
  async importMechanic(file: File): Promise<MechanicPack> {
    return bin("import_mechanic", new Uint8Array(await file.arrayBuffer()), {});
  },
  deleteMechanic: (id: string) => invoke<void>("delete_mechanic", { id }),
  chatMechanics: (chatId: number) => invoke<ChatMechanic[]>("chat_mechanics", { chatId }),
  setChatMechanic: (chatId: number, mechId: string, enabled: boolean) => invoke<ChatMechanic[]>("set_chat_mechanic", { chatId, mechId, enabled }),
  resetChatMechanic: (chatId: number, mechId: string) => invoke<ChatMechanic[]>("reset_chat_mechanic", { chatId, mechId }),
  setChatVariable: (chatId: number, mechId: string, path: string, value: unknown) => invoke<ChatMechanic[]>("set_chat_variable", { chatId, mechId, path, value }),
  renameDorm: (id: number, name: string) => invoke<void>("rename_dorm", { id, name }),
  deleteDorm: (id: number) => invoke<void>("delete_dorm", { id }),
  listChats: () => invoke<Chat[]>("list_chats"),
  /** `opening`: which of the character's greetings a one-on-one chat starts on (0 = the first message). */
  createChat: (dormId: number | null, name: string, kind: ChatKind, characterIds: string[], opening?: number) =>
    invoke<Chat>("create_chat", { dormId, name, kind, characterIds, opening: opening ?? null }),
  updateChat: (chat: Chat) => invoke<void>("update_chat", { chat }),
  deleteChat: (id: number) => invoke<void>("delete_chat", { id }),
  listMessages: (chatId: number) => invoke<Message[]>("list_messages", { chatId }),
  addUserMessage: (chatId: number, text: string) => invoke<Message>("add_user_message", { chatId, text }),
  editMessage: (id: number, text: string) => invoke<Message>("edit_message", { id, text }),
  deleteMessage: (id: number) => invoke<void>("delete_message", { id }),
  setSwipe: (id: number, index: number) => invoke<Message>("set_swipe", { id, index }),
  clearChat: (chatId: number) => invoke<void>("clear_chat", { chatId }),
  /** `continueMessageId` extends that (newest, character) message in place instead of starting a new reply. */
  generate: (chatId: number, characterId?: string | null, regenerateMessageId?: number | null, continueMessageId?: number | null) =>
    invoke<string>("generate", { chatId, characterId: characterId ?? null, regenerateMessageId: regenerateMessageId ?? null, continueMessageId: continueMessageId ?? null }),
  cancelGeneration: (requestId: string) => invoke<void>("cancel_generation", { requestId }),
  setAutoChat: (chatId: number, on: boolean) => invoke<void>("set_auto_chat", { chatId, on }),
  // profiles and sessions
  session: () => invoke<SessionState>("session_state"),
  signIn: (profileId: string | null, passcode?: string) => invoke<SessionState>("sign_in", { profileId, passcode: passcode ?? null }),
  signOut: () => invoke<SessionState>("sign_out"),
  createProfile: (handle: string, displayName: string, passcode: string) =>
    invoke<SessionState>("create_profile", { handle, displayName: displayName || null, passcode: passcode || null }),
  claimGuest: (handle: string, displayName: string, passcode: string) =>
    invoke<SessionState>("claim_guest_profile", { handle, displayName: displayName || null, passcode: passcode || null }),
  updateProfile: (displayName: string) => invoke<SessionState>("update_profile", { displayName }),
  setPasscode: (current: string, next: string) => invoke<SessionState>("set_passcode", { current: current || null, new: next || null }),
  setLaunchPref: (askOnLaunch: boolean) => invoke<SessionState>("set_launch_pref", { askOnLaunch }),
  prepareExport: () => invoke<ExportInfo>("prepare_export"),
  ejectProfile: (token: string) => invoke<SessionState>("eject_profile", { token }),
  deleteProfile: (confirm: string) => invoke<SessionState>("delete_profile", { confirm }),
  async inspectProfileFile(file: File): Promise<ImportPreview> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return bin("import_profile", bytes, { "x-mode": "inspect" });
  },
  async importProfileFile(file: File, handle: string, passcode: string): Promise<SessionState> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return bin("import_profile", bytes, { "x-mode": "import", "x-handle": enc(handle), "x-passcode": enc(passcode) });
  },
  // 3D crash guard
  vrmGuardBegin: () => invoke<boolean>("vrm_guard_begin"),
  vrmGuardEnd: () => invoke<void>("vrm_guard_end"),
  // settings
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  /** `provider` is "openai", "anthropic", or `custom-<profile id>`. */
  setApiKey: (provider: string, key: string) => invoke<string>("set_api_key", { provider, key }),
  hasApiKey: (provider: string) => invoke<{ present: boolean }>("has_api_key", { provider }),
  testProvider: () => invoke<string>("test_provider"),
  testProfile: (profile: ApiProfile) => invoke<string>("test_profile", { profile }),
  listRemoteModels: (profile: ApiProfile) => invoke<string[]>("list_remote_models", { profile }),
  // local models
  hardware: () => invoke<Hardware>("hardware_info"),
  listModels: () => invoke<ModelFile[]>("list_models"),
  deleteModel: (file: string) => invoke<void>("delete_model", { file }),
  downloadModel: (url: string, file: string) => invoke<void>("download_model", { url, file }),
  cancelDownload: (file: string) => invoke<void>("cancel_download", { file }),
  engineStatus: () => invoke<EngineStatus>("local_engine_status"),
  stopEngine: () => invoke<void>("stop_local_engine"),
};

export const onGen = (cb: (e: GenEvent) => void): Promise<UnlistenFn> =>
  listen<GenEvent>("dorms://gen", (ev) => cb(ev.payload));
export const onMechanics = (cb: (e: { chat_id: number }) => void): Promise<UnlistenFn> =>
  listen("dorms://mechanics", (ev) => cb(ev.payload as { chat_id: number }));
export const onModelProgress = (cb: (e: ModelProgress) => void): Promise<UnlistenFn> =>
  listen<ModelProgress>("dorms://model-progress", (ev) => cb(ev.payload));
export const onAutoStopped = (cb: (e: { chat_id: number; reason: string }) => void): Promise<UnlistenFn> =>
  listen("dorms://auto-stopped", (ev) => cb(ev.payload as { chat_id: number; reason: string }));

export const folderCover = (f: { cover_path?: string | null }) => (f.cover_path ? convertFileSrc(f.cover_path) : null);
export const musicUrl = (x: { music_path?: string | null }) => (x.music_path ? convertFileSrc(x.music_path) : null);
export const roomBackdrop = (r: { backdrop_path?: string | null }) => (r.backdrop_path ? convertFileSrc(r.backdrop_path) : null);
export const mediaUrl = (c: { media_path: string | null }) => (c.media_path ? convertFileSrc(c.media_path) : null);

// ---- card helpers -------------------------------------------------------

export const blankCard = (): CardData => ({
  name: "",
  description: "",
  personality: "",
  scenario: "",
  first_mes: "",
  mes_example: "",
  creator_notes: "",
  system_prompt: "",
  post_history_instructions: "",
  alternate_greetings: [],
  character_book: null,
  tags: [],
  creator: "",
  character_version: "",
  nickname: "",
  group_only_greetings: [],
  extensions: {},
});

export const blankEntry = (): BookEntry => ({
  keys: [], content: "", extensions: {}, enabled: true, insertion_order: 100, case_sensitive: null,
  name: "", priority: null, id: null, comment: "", selective: false, secondary_keys: [],
  constant: false, position: "before_char",
});

/** App-level fields we keep inside `extensions.dorms` so exported cards stay spec-compliant. */
export const dormsExt = (card: CardData): { tagline: string; display_name: string } => ({
  tagline: String(card.extensions?.dorms?.tagline ?? ""),
  display_name: String(card.extensions?.dorms?.display_name ?? ""),
});
export const displayName = (c: Character) => dormsExt(c.card).display_name || c.card.name || "Unnamed";
export const tagline = (c: Character) => dormsExt(c.card).tagline || c.card.creator_notes.split("\n")[0] || "";

/**
 * Save a prepared export where the user chooses. Desktop: the backend writes the file and checks it by
 * reading the bytes back. Android's save dialog hands out content:// addresses the backend can't write to,
 * so there the web view writes it and the size is checked. `verified` is what eject requires.
 * Returns null if the user cancelled.
 */
export async function saveExportFile(info: ExportInfo): Promise<{ path: string; verified: boolean } | null> {
  const path = await save({ defaultPath: info.file_name, filters: [{ name: "Desktop College Dorms profile", extensions: ["dorms"] }] });
  if (!path) return null;
  if (!path.startsWith("content:")) {
    await invoke("save_export", { token: info.token, path });
    return { path, verified: true };
  }
  const buf = await invoke<ArrayBuffer>("read_export", { token: info.token });
  await writeFile(path, new Uint8Array(buf));
  let verified = false;
  try { verified = (await stat(path)).size === info.size; } catch { /* some locations can't be inspected */ }
  if (verified) await invoke("confirm_export_saved", { token: info.token, size: info.size });
  return { path, verified };
}
