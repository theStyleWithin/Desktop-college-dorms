# Desktop College Dorms: Spec

The computer app is **Desktop College Dorms**; the Android app is **Mobile College Dorms**. They are one code base. Only the phone app's launcher name and APK file name differ; the app id (`io.github.thestylewithin.dorms`) is the same on both, so phones that already have the app keep their data and get updates.

An offline-first desktop app for creating AI characters and chatting with them one-on-one, in groups, or in Discord-style channels where characters talk to each other. Everything lives on the user's machine. Cloud APIs are optional.

The "dorm" theme is a skin, not a mechanic: rooms, a dorm hall, a common room. It was not the original intent, but it works as a visual identity (see UI).

## Decisions

| Area | Decision |
|---|---|
| Shell | **Tauri** (Rust backend, web frontend) |
| Frontend | **TypeScript + React**, with three.js (used directly) and `@pixiv/three-vrm` for VRM/VRoid models |
| Storage | Local SQLite for chats and characters, character images and media as files in the app data dir |
| Local models | **llama.cpp bundled in v1** as a Tauri sidecar (installed as `dorms-engine` / `dorms-engine-vulkan`), so install is plug and play with no external software. In-app model downloader (GGUF files) with hardware detection picks a sensible default size. Ollama or any OpenAI-compatible local server stays supported as an optional advanced endpoint |
| Cloud models | Optional, user-supplied API keys (OpenAI-compatible endpoints, Anthropic, etc.) |
| Privacy | Offline by default. Nothing is sent anywhere unless the user configures a cloud provider |

## Character profiles (media)

Profile media types, all optional per character:
- Still images: JPG, PNG, WebP
- Animated: GIF
- Video: MP4/WebM, looped muted in lists and in chat headers
- **3D models: VRM and VRoid** (VRoid Studio exports `.vrm`). Rendered with three.js + `@pixiv/three-vrm`. Uses: profile viewer, chat avatar with idle animation, expression changes (blendshapes) driven by message sentiment (later).

## Character creation (Chub-style, offline)

Copy the depth and freedom of Chub's create form, minus everything about publishing.

**Keep:**
- Name, avatar upload (image / GIF / video / VRM)
- Tagline, In-chat name, Creator's notes
- Tags (free-form; the "needs 3 tags" rule is dropped)
- Description, Initial message, Scenario, Example dialogs
- Live token counts per field plus total / permanent
- Advanced: alternate greetings (multiple), system prompt override, post-history instructions, character's note with injection depth, embedded character book (lorebook)
- Import JSON / PNG

**Drop (public-sharing features):** Public/Private/Unlisted, SFW/NSFW rating, publish anonymously, "search existing characters", content-policy text.

Characters are **editable at any time** after creation, including swapping media and editing the lorebook.

## Character card compatibility (hard requirement)

Importing must never error on a card from the Avakson editor (https://avakson.github.io/character-editor/) or other common tools, via JSON or PNG.

Plan:
- Support **V1** (flat fields), **V2** (`chara_card_v2`) and **V3** (`chara_card_v3`) cards.
- PNG: read the `chara` (base64 JSON) and `ccv3` text chunks. Prefer `ccv3` when both exist. Handle `tEXt`, `zTXt` and `iTXt` chunk types.
- JSON: accept bare card objects and `{spec, spec_version, data}` wrappers.
- **Lenient parsing:** every field optional with defaults, wrong types coerced, unknown fields and `extensions` preserved untouched and written back on export so round-trips lose nothing.
- Never reject on a schema mismatch. Import what is understood, keep the rest, and show a non-blocking warning list.
- Export back to PNG (embedding the card) and JSON.
- **Test suite:** collect real exports from the Avakson editor (V1/V2/V3, JSON and PNG, with and without a character book) and from SillyTavern/Chub as fixtures, and assert import → export → import is lossless. I have not yet inspected that editor's actual output; do this first when building.

## Chat

- **1:1 chat** with a character: swipe/regenerate, edit and delete messages, alternate greetings picker.
- **Group chats:** multiple characters in one conversation, with turn-taking (round-robin, random, or addressed by @mention) and a shared context.
- **Discord-style servers/channels:** a "dorm" has channels (#common-room, #late-night, ...). Characters can be added to a channel, talk to the user and to each other, and can be set to auto-chat on a timer or on demand. The user can pause, step, or mute individual characters.
- Per-character and per-channel prompt assembly: system prompt, description, scenario, example dialogs, lorebook entries triggered by keyword, character's note injected at depth, post-history instructions.

## UI

Inspired by Saucepan (the screenshots in the design discussion), not a copy: our own name, logo, palette and assets.

Layout ideas:
- Dark theme, serif display headings, rounded cards.
- **Home:** greeting, a "resume chat" row of circular character avatars, then sections for Characters, Lorebooks, Collections.
- **Browse/library grid:** local characters as cards with avatar, name, tagline, tag chips, token count, last-used date. Tabs: Collections, Lorebooks, Recent, Favorites, Search. No "trending/popular" since nothing is online.
- **Chat view:** sidebar of dorms/channels like Discord, character list per channel, message pane, avatar panel (image/video/VRM).
- Theme toggle, per-character accent colors.

## Network privacy

- Offline mode: no network calls at all. Local model traffic stays on `localhost`.
- When a cloud API is configured, all requests go over **HTTPS/TLS 1.2+** (via `rustls` in the Rust backend). That already encrypts content in transit, so cellular carriers and Wi-Fi operators cannot read it; they only see that a connection to the provider's host exists.
- Do **not** invent custom encryption on top of TLS. It adds bugs and no real protection, because the provider has to read the plaintext anyway.
- API calls are made from the Rust backend, not the webview, so keys never touch frontend code.
- API keys are stored in the OS keychain, not in plain files.
- Optional: certificate pinning for known providers, and a visible indicator in the UI showing when a message is going to a cloud provider versus staying local.
- Local data at rest: optional database encryption (SQLCipher) behind a setting, off by default.

## Milestones

1. Scaffold Tauri app, SQLite schema, app shell.
2. Character model + card import/export (V1/V2/V3, JSON + PNG) with the fixture test suite.
3. Character editor (Chub-style form with token counts) and library grid.
4. Bundle llama.cpp sidecar + first-run model downloader; 1:1 chat against it; prompt assembly with lorebook, depth notes, post-history.
5. Media: GIF/video profiles, then VRM viewer.
6. Group chats, then Discord-style channels with bot-to-bot conversation.
7. Cloud providers over TLS, keychain storage, privacy indicator.
8. Polish, theming, packaging for Windows/macOS/Linux.

## Decisions made

- **llama.cpp is bundled in v1** (plug and play, nothing external to install). The one unavoidable first-run step is downloading a model file, which the app does for the user.
- **Background bot-to-bot chat is optional and off by default**, because it drains PC power. Per-channel toggle, a pace setting and an automatic stop after N bot-only turns. (Battery-aware pausing was planned but is not implemented.)
- **Any API**: besides OpenAI-compatible and Anthropic, an *Other API* section holds saved custom endpoint profiles (OpenAI-style or Anthropic-style, custom base URL, path, auth style, headers, extra JSON body, model listing) so new services work without a code change.

- **React for the frontend.** Larger ecosystem and the best-supported 3D/VRM tooling (react-three-fiber), which matters for VRoid model support.

## Open questions

None at the moment.

## 3D viewer

The profile viewer for VRM / VRoid models is a furnished dorm room built from simple shapes in code (no image files shipped). The model
is posed from its humanoid rig (VRM 0.x and 1.0 handled, since their axes differ), breathes, blinks and tracks the camera, and its own
spring bones are simulated for hair, skirt, sleeves, ears and chest, with a Natural / Bouncy / Off setting. Virtual hands (gamepad,
mouse or touch) let the user pet the character. When nobody is chatting, a small rule-based NPC layer (no AI) runs her day: path-finding
around the furniture, a procedural walk cycle, activities with props (phone, coffee), sitting and sleeping on the bed. Imported models
are only ever the user's own files; nothing is bundled.

## Wardrobe

A 3D character can hold extra outfits: more VRM files of the same character (for example exported from VRoid Studio in other clothes).
The backend owns them (add, switch, rename, remove; they follow the character through backup, eject, import and delete), and the viewer
shows the one being worn. Accessories are found by material name (VRoid's `Accessory_CatEar_01_CLOTH` and friends) and can be switched
on and off per model: cat, dog, fox, raccoon, bunny and wolf ears and tails, plus glasses, hats, hair accessories, bags and shoes.
Garments such as tops and bottoms are changed by swapping to another outfit file, not hidden one by one.

## Voice input

A mic button in the chat composer records 16 kHz mono WAV in the webview (a voice-activity check ends the recording when the user stops
talking), the Rust backend sends it to an OpenAI-compatible `/audio/transcriptions` endpoint chosen in Settings → Voice (OpenAI, Groq,
or a local Whisper server for offline use), and the resulting text is sent as the user's message (or dropped into the box, by setting).
The API key lives in the keychain like the chat keys; internet servers must use https. The 3D character pays attention while the mic is open.
Not built (yet): spoken replies (text to speech), and bundling a Whisper engine inside the app.

## Rooms, mechanics, folders, notes (v0.4)

- **Rooms** are rows (name, kind, description, owner, backdrop, music). A dorm may be set in one room; its description reaches the prompt
  ("Setting: ..."). A backdrop is a built-in preset or an image the app saved itself; the web view can't name an arbitrary path.
- **Mechanic packs** are `.bundle.json` files (variables, notes, reactions). Packs live in a library; each chat switches them on or off and keeps
  its own state. The model writes hidden `[variable: set|add|subtract|push|remove value]` lines, applied with the pack's min/max and per-change limits and
  stripped from the reply. Reactions (keywords, every N turns, crossing a threshold) run on the player's and the character's messages. Pack UI code is never executed.
- **Phone mode** is a per-chat style (`chat` | `phone`): a texting view and a texting instruction in the prompt.
- **Folders** nest (up to 12 levels); filing is backend-owned (editing a card never moves it). A folder shows its own picture, else the picture of a chosen character inside it (`cover_char`). Cards keep a user order (`order`, lower first; unplaced cards go last) that is set by dragging, per folder; moving a card to another folder resets it. **Framing** (x, y, zoom) is stored beside the picture and
  applied with CSS, so the original image is untouched.
- **Notes** and **lorebooks** are per profile. Backups carry all of it (rooms, music, packs and their per-chat state, notes, folders, lorebooks, framing).

## Profile decorations

- The ids, names and blurbs of the nameplates, profile backgrounds and avatar wreaths are in `src/lib/decoData.json`; the Rust side reads that file (`deco.rs`) and
  the page draws the art from `src/lib/decoCore.js` (ported from Anti-Social, same author): each picture is SVG with its own small animations, handed to the page as one
  style sheet, a moving set and a still set (`html[data-deco-anim="off"]`). A test keeps the file and the art code naming the same things.
- The user's own: `settings.deco` (nameplate, background, wreath, animate, a 2 to 4 letter tag with one of eight colours and one of eight symbols, a built-in banner, and
  `ai_pick`). It is cleaned on every save and import (`clean_user`) and travels with the settings in a backup.
- A character's: a `char_deco` row per profile and character (`plate`, `bg`, `wreath`, `source` = `user` or `ai`), removed with the character and carried in backups.
  `set_char_deco` takes known ids only and, given nothing, removes the row. `generate_char_deco` lists every choice to the model with the character's description,
  personality and tags, asks for one JSON object, keeps only known ids (a reply with none is refused and changes nothing) and stores it as `ai`; it runs only if a cloud model is set
  up or the local one is already running. With `ai_pick` on, the characters list picks, one at a time and never in a burst, for characters in view that have no row at all.
- Shown: the user's nameplate, wreath and tag on the side bar's profile button; the profile card (Settings → Profiles and its Decorations section); a character's nameplate and wreath in
  the characters list, and their wreath on chat pictures.

## Pathways

- A room may be part of another room (`parent_id`, never itself or anything inside it, checked on the backend) and may lead to other rooms by
  exits (`room_links(a,b)`: one-way pathways from a to b, at most `MAX_EXITS` = 3 per room, only to the owner's own other rooms; the command refuses a fourth, while the database layer keeps whatever a backup brings). Deleting a room lifts what was inside it one level and removes its pathways.
- A chat has an optional `room_id`: the room the story has walked into. The room of a chat is that one, else its dorm's. `move_chat(chat_id, room_id)` sets it,
  refuses the room the chat is already in, and appends a message with role `travel` (its text is the room's name). The chat page shows it as a divider line;
  the prompt gets it as narration (`[The scene moves to Kitchen.]`) and the system prompt describes the current room, the room it is part of, and
  where one can go (its sub-rooms, its neighbours in the same parent and its exits). The Go to menu offers the same: the room's exits, then the rooms around it by `parent_id`; a chat in no room at all may enter any room; a room with neither shows "No way on from here". `move_chat` itself does not check the route. Deleting the room a chat is in puts the chat back in its dorm's room.
- The Rooms page has a Cards / Pathways editor switch (kept on the device). The editor draws each room as a card with a handle; dragging from a handle onto another room adds an exit to a
  draft (an arrow; refused beyond three) and the ✕ on an arrow removes one from it. Nothing is stored until **Save pathways**, which calls `set_room_links` for each room whose exits changed and
  keeps the card positions; **Discard** drops the draft, and leaving the editor with unsaved changes asks first. Two rooms that lead to each other show two arcs. Card positions are kept in `dorms.rooms.map` on the device; dashed lines are `parent_id`.
- A moved chat prefers the new room's music over the dorm's. Backups carry parents, pathways and each chat's current room (numbers are remapped on import).

## Novel writing

- `novel_start(chat, plot, tone, pov, chapters 1..60, chapter_tokens 300..4000, resume)` writes one chapter per reply (`generate_once` with a `[NOVEL MODE]` directive added to the system
  prompt and the reply length raised to `chapter_tokens`); the plan and progress are kept in `chat_novel`. `novel_stop` cancels the running reply and drops it (nothing half-written is kept).
  Replies are normal character messages; the stop message is a `note` message (never sent to the model).
- Requests are counted per profile per day in `novel_usage`. With `novel_daily_limit` > 0 the plan is cut to `limit - used - novel_reserve` chapters; when nothing is left it stops after a
  finished chapter ("budget"). A 429/quota error waits and retries (30 s, then 90 s) unless it says the day's allowance is gone, in which case the day counts as used up ("limit").
- The writer runs inside the app. Closing the main window while a novel is written is stopped by the backend (`CloseRequested`) and asked about (`dorms://close-while-writing`): `hide_to_tray` hides the window and makes a tray icon (Open / Quit) that exists only while hidden, `quit_app` closes. The window is revealed again when the last novel ends. Without a tray (phones, desktops with no tray host) the fallback is a plain warning; nothing runs after the app is quit, and a novel resumes from the last finished chapter.

## Playbooks

- A playbook (`playbooks` table, JSON per profile; up to 10 values, 15 rules of which 3 may ask the model, 4 lorebooks, 8 scenarios) holds typed values (`number` with range and
  bands, `bool`, `text`, `choice`), rules (`before`/`after` a reply; all-of and any-of conditions: value comparison, user says, reply says, every N turns, chance; changes: set, add,
  subtract, toggle, append, clear), lore gates (`#N` or entry name) and scenarios. `clean_playbook` makes any definition safe and within these limits.
- A chat's story (`chat_playbook`: mode `inherit`|`none`|`set`, state, turn, model-judging switch, starting state, pending state) and a snapshot per reply (`playbook_snap`) make
  regenerate rerun from the state before the turn, continue not advance, and deleting messages rewind. A reply that fails puts the pending state back.
- The prompt block names each value with what it means; lorebook entries of the playbook's books join the character's own when the state makes them available.
- Backups carry playbooks, each character's playbook and each chat's story state (lorebook ids are remapped to the new copies).

## Worlds

- A room's gallery (`rooms.gallery`, JSON of `{id,file,caption}`, at most `MAX_ROOM_PICS` = 24) holds copies of pictures in `media/roompic-*`; captions go into the room block ("Details of this place"). Deleting the room or a picture deletes the file; backups pack and re-import them.

- A world (`worlds` table: name, description, created time; per profile) is a folder of rooms; `rooms.world_id` says which (none = not in a world). `world_lorebooks(world_id, book_id)` attaches
  lorebooks (only the owner's own). Rooms, `parent_id` and exits never cross between worlds: `valid_parent` and `set_room_links` refuse a room of another world, and `move_rooms_to_world(ids, world)`
  moves a set at once, then drops every link that now joins two different worlds (so a connected set moved together stays connected). A room made for someone else's world is put in none.
- A world has a `description` (short, told to the characters) and a `lore` (up to 20,000 characters, written to be read: headings with `#`/`##`, lists with `-`, `**bold**` and `*italic*`; shown on the world's overview page,
  never sent to the model). The overview lists the world's rooms (with a Start here button for each), its exits, and its attached lorebooks.
- Deleting a world never deletes its rooms (they are simply in no world); deleting a lorebook takes it off every world. Backups carry worlds and their lorebooks (numbers remapped on import).
- A chat is in the world of the room it is in now (so walking through a room in another world changes it). The system prompt names the world and its description, and the lorebooks attached to the
  world are merged with the speaker's own lorebooks (each book once) when the prompt is built, so they apply in every chat in any room of the world.
- The Rooms page has a world bar (all rooms, each world, rooms in no world; make one; for the one picked: name, description, lorebooks, make a room in it, delete it). The room form picks the room's world and can move the
  rooms connected to it along. The Go to menu of a chat in no room, and the dorm's room list, group rooms by world.

## Imported 3D rooms (v0.6)

- A room may carry a 3D model (`.glb`, `.gltf` with everything inside it, or `.fbx`, 300 MB at most, checked by its first bytes) that replaces the built-in 3D room in chats set in that room.
  Size, turn and height are stored on the room. The file is saved by the app itself (`media/roommodel-*`); the web view never names a path.
- The loader finds the floor (the lowest large flat surface), puts it at height 0 and the middle of the floor at the origin, and treats FBX files that are clearly in centimetres as such.
  Walkability is worked out once from the triangles: floor is an upward-facing surface near height 0; anything standing between 0.22 m and 1.6 m (walls, furniture) blocks; the result becomes the
  same floor rectangle and obstacle rectangles the built-in room uses, so path finding, carrying and the camera limits need no special case. With no floor found she may walk anywhere that is not blocked.
- Her plans in an imported room are wandering, using the phone standing up, and stretching (no bed, desk or window).
- **Sharing.** Each model has a sharing mark, default *not allowed to share*. Only a model marked shareable is written into an exported profile (with its size, turn and height), and it comes back marked shareable.
  An unshared model is left out, the export lists its room as withheld, and ejecting removes the file from the device (the dialog says so). The mark is the owner's own declaration; it is not verified.
- **Unity packages.** A `.unitypackage` (gzip tar: a folder per asset GUID with `asset`, `pathname`, `asset.meta`) is sent to disk with the chunked upload, then scanned in one streaming pass that reads
  only the asset paths, sizes and the small text materials; nothing is executed. It is refused (nothing kept) when it is not a package, is over 4 GB, has less free space than about three times its size,
  or holds no usable model (`.fbx` and `.glb` are used; `.blend`, `.max`, `.obj`, `.gltf` and the like are named in the refusal; a scene or prefabs without a room model are refused as separate pieces).
  The chosen model and only the pictures its materials use are unpacked to a temporary folder, refused if together they exceed 1 GB or the free space. An FBX is rebuilt in the web view with the Unity materials'
  main texture and colour put back (pictures scaled to at most 2048 px) and written as one `.glb` (GLTFExporter), which then goes through the normal room-model path; a `.glb` is used as it is. The temporary files are
  always removed. Unity shaders, prefabs, scenes and baked lighting are not read.

## Side bar extras (v0.10)

- Under *Prompts* the side bar shows up to four sections, each foldable and switchable in Settings → Customization (local storage; hidden below 820 px): **Recent chats** (by the chat's `updated_at`, five, ten with "Show more"), **Favorites** (the characters' existing `favorite` flag, all of them, sorted by name; a picker with a checkbox per character toggles it), **Most used** (`character_usage`: the number of messages written by each character across the profile's chats, counted from the stored messages so it covers history; the top five)
  and the **picture frame** (a character the user chooses with the pencil, kept in `dorms.side.frame` on the device until changed; with nobody chosen, the first character of the newest chat. It shows the gallery picture chosen for them in their latest chat when there is one, else the main picture; view-only, a click opens that chat, or starts one). Clicking a favorite or a most used character opens the newest chat that includes them (a one-to-one chat first), or starts one.

## Character gallery and mood pictures (v0.10)

- A character has `gallery` (items: id, file, kind `image`/`gif`/`video`, moods) and `gallery_mode` (`fixed`, `random`, `mood`; empty means fixed). Like the main picture, the gallery is owned by the backend: saving a character from the editor never replaces it, it changes only through
  `add_gallery_image` (raw upload, up to 200 items and 60 MB each, no 3D models), `set_gallery_moods`, `remove_gallery_item` and `set_gallery_mode`. Files are `media/<char>-gal-<item>.<ext>`, removed with the item or the character, packed into profile backups under fresh names and restored with only valid kinds and known moods.
- Moods are a fixed list of 12 (neutral, happy, laughing, loving, embarrassed, smug, surprised, scared, sad, angry, thinking, sleepy). **Mood detector** (`src/lib/mood.ts`, runs in the web view, offline, no model call): per mood a set of word, action and emoji patterns; each hit counts one, two inside an *action*, a little more in the last 40% of the reply; hidden `[variable: ...]` lines are ignored; the best mood wins with a score of at least 1.5, ties by a fixed order, otherwise neutral.
- **Choosing the picture** after each new character reply (not for messages already in the chat when it is opened, which also covers opening an old chat): `random` any picture except the one shown; `mood` one tagged with the detected mood, else one tagged neutral, else an untagged one, else the main picture; `fixed` the main picture. The choice is kept per chat and character in local storage. It shows on the stage (not for a 3D character), on the character's latest message and in the members list of the chat.

## Panels, the characters list, statuses (v0.9)

- The shell is a grid of side bar, middle and (on windows wider than 1100 px, when shown) the characters list. The two outer widths are CSS variables (`--side-w`, `--members-w`) set from values kept in local storage; a wall element between panels is dragged with the left button (pointer events on the window while dragging), clamped between a minimum and a maximum that leaves the middle at least 480 px,
  double-click resets, arrow keys nudge. The side bar items carry their order in local storage (unknown pages are dropped and new ones appended); drag and Alt + arrows reorder; *Prompts* is outside the list and fixed at the end.
- **Presence light**: `provider_health` answers `local` for the built-in engine (no probe, never starts it), otherwise probes `GET {base}/models` (8 s): 2xx, 404, 405 are `ok` (it is up); 401/403 and 429 and other 4xx are `warn`; timeouts, connection errors and 5xx are `down`; a missing key or profile is `none`.
  The list checks on start, every 60 s while the window is visible, on focus and when the model settings change. One light for everyone: the model is a global setting.
- **Statuses** (`char_status`, one short line per character, private per profile, removed with the character, not part of backups since they can be written again): `generate_status` asks the model for one line (at most 80 characters, no quotes, not explicit, never "as an AI"; the answer is cleaned to one line and refused if it reads as an apology) from the card's description and personality and the time of day.
  A local model is used only if it is already running (a status is not worth loading a model). Writing them by themselves is opt-in, one at a time, for characters in view that have none or a status older than 12 hours; after a failure it pauses for five minutes.

## Prompts (v0.8)

- A per-profile library of saved prompts (`prompts` table: title, body, optional short label), private like every other row and part of backups. Title up to 100 characters, text up to 200,000, up to 1000 prompts.
- The side bar's *Prompts* item is a drop-down (a floating panel above the bottom bar on a phone), not a page, so a roleplay is never left. Each row is draggable (`application/x-dorms-prompt` carries the title and text) and clickable.
- Dropping on the chat: with an empty message box (and she is not replying) the text is sent as the user's message at once, exactly as if typed; with text already in the box, or while she is replying, the prompt goes into the message box (before what was typed) and nothing is sent.
  Clicking a row puts the text in the message box of the open chat (or copies it when no chat is open), which is also the way to use one on a touch screen.

## Text size (v0.8)

- The size of chat text is a multiplier (0.8 to 2, in steps of 0.05) stored on the device in local storage (it differs between a phone and a desktop, so it is not part of the profile or its backups) and exposed as the CSS variable
  `--chat-scale`. Message text, the message editor, the composer and the texting-style bubbles scale with it; the rest of the interface does not. One slider is in the chat header, another (with a sample) in Settings → Customization; they stay in step.

## Decorations (v0.7)

- A per-profile library (`decor` table, files `media/decor-*.glb`) of 3D props. Items come from a Unity package (the same streaming scan and extraction as rooms, for several models in one pass, with more room allowed: 2 GB of models and pictures
  instead of 1 GB), or from one `.glb` / `.fbx` (an FBX is converted to a `.glb` in the web view). Every item is stored as a `.glb`, uploaded with the chunked upload and accepted only if it starts with `glTF`.
- Each item has the same **sharing mark** as a room model, default *not allowed to share*. Only shareable items are written into an exported profile (and come back marked shareable); the export lists the withheld ones,
  and ejecting removes every item's file from the device, which the dialog says. Items are private per profile, like every other row.
- Placing items in a room (decorate mode, saved per room, with her walking around them) is the next step; for now the library only holds them.

## Hands: pet, poke, tickle, pick up

- Three gestures share the virtual hands: open (pet), pointing finger (poke, hold to tickle) and pinch (pick up). Where a poke lands is found from simple body proxies
  (spheres along her skeleton), not the mesh, so it is the same for every model and costs nothing per frame. Only ordinary regions react (face, ears, shoulders, arms,
  hands, back); anywhere else she just looks puzzled.
- Reactions are additive poses and expressions applied after the NPC pose each frame, so they work whatever she was doing. Tickling builds a laugh level; a tickle during
  the stretch plan ends the stretch and jumps straight to full laughter.
- Pick-up: the scruff follows the fingertips (a spring), the body hangs from it as a damped pendulum driven by the hand's acceleration, then free-falls with cartoon
  gravity, squashes, and is placed on the floor (clamped to the room and out of the furniture). The NPC is paused while she is carried and resumes after.
- The mouse is the hand: pressing lays it on her (open), Shift or the right button uses the left hand, left and right together pinch, keys 1-4 pick the gesture. Free roam (C) walks the camera with the arrow keys; Q/E change height.
- Controllers are read through the standard Gamepad layout (buttons by position). Bindings are per device in local storage; labels come from the pad's vendor (Xbox, PlayStation,
  Nintendo, Steam).

## Planned: world attachments (quality of life for worlds)

Not built yet. A world already carries lorebooks that apply to every chat in its rooms. The plan is to let a world carry more, so a place can come with its own set-up:

- **Persona.** A persona can be assigned to a world. While a chat is in a room of that world, the AI reads the world's persona instead of the active one; the active persona is never changed or deleted and returns when the chat leaves the world (walking through an exit into a room of another world changes it, as the world's lorebooks already do). The chat's "Playing as" box says "World persona: X (from Y)" and has a switch to ignore the world's extras for that one chat. Messages already written keep the name and picture they had. If the persona is deleted, the world falls back to the active persona. Backups carry the assignment.
- **Playbook.** A world can have a default playbook. Only one playbook runs in a chat, so the order is: what was chosen for the chat, then the character's own playbook, then the world's. The world's is only a fallback and never replaces a character's.
- **Lorebooks** (already there): they merge with the character's own, each book once; if they compete for space the character's own entries come first.
- **Prompts.** Both of these, with a switch on each attached prompt: (1) a world's prompt shelf, where its prompts show first in the Prompts menu while in that world, sent only when the person chooses; (2) standing instructions, always told to the characters, placed after the character card's own system prompt, which wins if they disagree.
- **The rule: a world adds things and never replaces a character's own.** The persona is the one exception, because it is the person's own choice about who they are.
- The Rooms page's world panel gets the pickers (persona, playbook, prompts) next to the lorebooks, and the chat shows one line, for example "From this world: playbook X, 2 lorebooks, persona Kai".
- Intended as a small patch release (0.13.2), tested with the app's own tests and a fake model (a real roleplay was not tested).

## Fewer Settings tabs

The Settings page has eight tabs (it had eleven): **Profiles**, **Customization**, **Personas**, **Models**, **Voice**, **Controller**, **Privacy** and **About**.

- **Profiles** = the old Profile and Decorations tabs. The profile sections come first; **Decorations** is a section folded away by default (its picker is large) and its content is not drawn until it is opened. The profile card shows once.
- **Customization** = the old Chat and Appearance tabs, plus **Emoji & stickers** (a folded section at the bottom). The Chat and Appearance settings save by themselves about half a second after each change, so nothing in this tab needs the Save button (a "Saved ✓" note appears). A half-typed number below its minimum (a context size under 512, a reply length under 16) is not saved until it is valid. The Save button stays for the other tabs (Models, Voice).
- **Old tab names still work**: anything that opens the old Profile, Decorations, Chat, Appearance or Emoji tab opens the new tab, with the Decorations or Emoji section unfolded where that applies.
- Nothing stored changed. Tested with the app's own tests (the folded section, one profile card, a Chat setting saving without the Save button); not checked on a real phone.

## Moving a profile between devices over home Wi-Fi (stage 1)

Stage 1 is built: a whole profile, in both directions, between two devices on the same network (`transfer.rs`, `components/TransferDialog.tsx`, `components/QrScanner.tsx`, in Settings → Profiles → Wi-Fi transfer).

- **How it goes.** The sending device listens on its address on the home network (found without sending anything; refused if it is not a private, link-local or loopback address) on a random port, only while its Send screen is open, for at most 5 minutes, until one device pairs or three wrong codes lock it. The receiving device connects to that address (it refuses addresses that are not on a home network). The QR code says `DCD1|<address>|<code>`.
- **The code** is any text of 1 to 200 characters, used exactly as typed (spaces count); if none is chosen, 8 random characters without look-alikes are used. It is never sent. The two devices run SPAKE2 (`spake2`, Ed25519) with the code as the password, so a short code cannot be guessed from a recording of the exchange; it can only be guessed by connecting live, which the sender allows three times. The shared secret and the two exchanged messages are hashed into a ChaCha20-Poly1305 key. Both sides then send a confirmation frame, which fails if the codes differed.
- **Frames.** After pairing, every frame is length-prefixed and encrypted, with a nonce made of the direction and a counter, so a frame that is changed, repeated, dropped or reordered is refused. A frame is at most about 192 KB of the file; a pause of 30 seconds ends the transfer.
- **The file** is the ordinary profile export (`build_export`). The sender announces its name, size and SHA-256; the receiver refuses one over 2 GB, then checks the length and checksum at the end and tells the sender whether it arrived whole. It lands in the staging place a chosen profile file lands in, and the screen shows the same preview as an import (name and counts of characters, dorms, chats, messages and files); the person then chooses **Add as a new profile** (with a name, and an optional passcode) or **Discard**. Nothing is added before that.
- **Safety.** API keys are not sent (an export never has them), so they are added again on the new device. A profile with a passcode asks for it before it is sent. The sender and the receiver are separate, so a device can be set up to do either.
- **Not in stage 1**: "Replace this profile" (it only adds a new one, and says if a profile with that name is already here), sending single items, a remembered pairing that refreshes only what changed, and the optional run of flashing QR codes. Stage 4, two-way sync, is not planned.
- **Camera and network on phones.** The Android build adds the camera permission (and says a camera is not required, so a phone without one can type the address and code). Android may also ask about local network access; that was not tried.
- **Tested**: unit tests of the key agreement (any text pairs; one letter off does not), of tampering and repeated frames, of the file arriving whole with progress, of a file that is too big, of the pairing text, and of which addresses are accepted; and end-to-end tests in which the app sends its profile to itself over a real connection on the computer (a wrong code, the three-tries lock, the right code, the arrival screen and adding it as a new profile). **Not tested**: two real devices on a real network (a computer and a phone), the camera and QR scanning, a router that keeps devices apart, the operating system's firewall and permission questions, and a large profile over Wi-Fi.

## Drag a character into a chat

Built (draft). A new room, in a world or not, can have a chat with nobody in it (the chat page then says "Characters in this chat show up here"). The plan is to let a character be dragged from the characters list on the right into the panel beside the chat that normally shows who is in it:

- **Start a chat.** Dropping a character on that panel while the chat is empty adds them, so the conversation can begin without opening "Who's here".
- **Quick group chats.** Dropping another character on the panel adds them too, so a group chat is made by dragging people in.
- **A one-to-one chat (a DM) becomes a group chat** when a second character is dropped. Because that changes how the characters are prompted (in a group each message is labelled with who said it), it asks first ("Make this a group chat?"). Messages already written are kept as they are.
- **Same limits and rules as "Who's here"**: the same people can be added, a character already in the chat is not added twice, and there is a sensible cap on the group's size. A playbook, lorebooks and the room's world apply as they do to any chat.
- **Touch and keyboard.** Dragging is unreliable on touch screens and out of reach for keyboard users, so the panel also gets an "Add a character" button and a long-press or menu option on a character in the list. Dragging a character out of the panel (or a small remove button) takes them out again.
- Built with: rows of the characters list on the right are draggable; the chat's side panel is the drop target; an "Add a character" button on the panel opens "Who's here"; the cap is 8 characters. Not tested: a real mouse or touch screen (the app's tests send the drop events themselves). Before building the plan was to show rendered pictures of the empty panel, the drop highlight and the group-chat question. It can only be tested with the app's own tests and a fake model, and drag-and-drop with a real mouse and a touch screen was not tested.

## Planned: a built-in model on Android phones

**Started (0.14.x):** `phone.rs` and a card in Settings → Models on Android. `phone_check` reads the phone's memory, free storage (on the disk that holds the app's data, through the system disk list) and whether it is a 64-bit ARM build, and compares them with a rule per model (the 1B model from about 6 GB of memory, the 3B from about 8 GB, the 7B from about 16 GB with a warning that it may be slow, hot and hungry for battery; each needs its file plus 1 GB of free storage; a 1 GB allowance is added to the memory read because phones report less than the number on the box). It returns a plain explanation, a line per model and `download_allowed`, which is true only for a phone that can run a model **and** only once `engine_supported()` is true, so a phone that can't run a model never gets a download button and no phone gets one before there is an engine. The numbers are guesses to be confirmed on real phones. Still to do: the engine itself (llama.cpp as a library for 64-bit Android), the download on a phone that can run one, the start-up memory check, the speed test and the cost screen.

Not built yet. Today the Android app has no built-in engine: the desktop builds run a helper program (`llama-server`) and Android does not allow an app to launch one, so the phone uses a cloud or network model. The catalog already lists **Llama 3.2 3B** (`Llama-3.2-3B-Instruct-Q4_K_M.gguf`, about 2 GB), but downloading it on a phone would be pointless without an engine to run it, so the plan is to do both:

- **An engine inside the app.** llama.cpp built for Android (arm64) as a library that runs inside the app process, answering the same requests the desktop's helper does. This is the big part. It needs the Android build tools in CI, the 16 KB page-size rule of newer Android versions, and a way to keep the model loaded without the system killing the app.
- **Download on the phone** with the existing resumable downloader, into the app's storage. The catalog shows only models the phone can hold: Llama 3.2 1B and 3B on most capable phones, and the bigger ones only on phones with a lot of memory, with a warning.
- **Hardware detection decides what is offered.** The app reads the phone's real memory (the physical total, not "virtual RAM" borrowed from storage, which some gaming phones add), its processor type (the engine is 64-bit only, so a 32-bit phone gets nothing), the free storage, and the Android version. A model the phone cannot run **has no download button at all**: there is just a plain line saying why ("This phone has 4 GB of memory; local models need at least 8 GB. Cloud and network models work as usual"). Starting guesses, to be confirmed on real phones: Llama 3.2 1B from about 6 GB of memory, Llama 3.2 3B from about 8 GB, the bigger models only from about 16 GB and then with a warning. A model also needs its file size plus about 1 GB of free storage. A phone close to the line sees the button with a warning about slow replies, heat and battery.
- **A check on every start:** the model is not loaded if memory is short at that moment (for example many apps are open), and the app says so instead of crashing. A short speed test says what to expect, and a screen explains the cost (about 2 GB of storage and about 3 GB of memory for the 3B model).
- **Aimed at recent flagship phones** (for example the RedMagic 8 Pro and up, which have a lot of memory and a cooling fan). Speed has not been measured: a 3B model on a phone's processor may be a few to a dozen words a second, so replies will be slower than a cloud model.
- **Cloud and network models stay the default** and keep working as they do now.
- **Before building:** rendered pictures of the phone's Models tab (the "this phone can run" card, the download and the speed test). CI can only prove it builds; whether it runs, how fast, and whether the phone overheats can only be tested on a real phone, so a real test on one is needed before it is released.

## The Tokenator chat (side bar)

A general chat that is not a character (`TokenatorChat.tsx`, command `tokenator_chat`). It uses the selected model and answers general questions and questions about the app.

- **The built-in guide** (`guide.rs`): the README, SPEC and SECURITY files are compiled into the app and cut into sections by heading and by the bullets of the long lists. A question is searched only if it contains a word that names a part of the app (playbook, lorebook, profile, room, android, and so on); the best few sections (at most four, about 5,000 characters, each matched by word frequency weighted by how rare a word is across the guide) go into the instructions, marked "planned, not built yet" when the section is about something unbuilt, and the reply lists their titles ("Read from the app guide"). A question that is not about the app, or that matches nothing well, sends no guide, and the model is told it has none. It is as of the installed version (the instructions name the version); an offline copy does not fetch newer docs. HANDOFF.md and other internal notes are not included.
- **Pictures, gifs and videos** (`lib/frames.ts`, `lib/vision.ts`): up to four files a message. Pictures are shrunk and sent as JPEG; a gif is sent as its first frame; a video as four still frames, with no sound (the reply line says which). Whether the selected model can see them is worked out from the provider and the model's name: the built-in engine can't, Anthropic models can, OpenAI-style models are matched against a list of known picture models, and anything else is "can't be sure", for which there is a switch ("This model can see pictures", kept per model, off by default). If the model can't see (or the switch is off) the app does **not** send the file; it adds a note of its own to the chat saying so, and tells the model that files were attached which it cannot see (so it must say so, not describe or guess), however many times they are attached again. Pictures go to OpenAI-style servers as `image_url` parts and to Anthropic as `image` blocks (`llm::stream_chat_values`); only the newest message carries pictures. Tested with a fake model; whether a real model can see a real picture, and whether a real video decodes in the web view on each system, was not tried.
- **Voice**: the same microphone button as the chats, using the speech-to-text server chosen in Settings → Voice.
- **Personality**: a saved prompt dragged from the Prompts menu onto the chat becomes Tokenator's personality (kept on the device, with a "back to normal" button). It is put in the instructions after the rules, with a line that it changes only how Tokenator talks and that the rules (honesty about files, no invented features, keep helping) still apply. A model may not always obey that line; the app-written note about files does not depend on the model.
- **Side bar**: Tokenator is the first item by default. For a device that already has its own saved side bar order, a page added later (Tokenator is the first such page) is put at the top, once, because it is missing from the saved order; after that it is an ordinary item that can be dragged, and any move saves the whole order, including it.
- **History**: the conversation's text is kept on the device (the last 60 messages; pictures are not kept) and has a Clear button. Replies arrive all at once, not word by word.

## Cards handed over from outside

Other programs (Sudo Make Art's card editor, a file manager) can start the app with a card to import. `dorms_core::cli::card_args` picks the card paths out of the program's arguments (`--import-card <file>`, `--import-card=<file>`, or a bare path ending in `.png` or `.json`; anything else is ignored; at most 20). `handoff.rs` keeps them waiting until a profile is open; the window then asks for them with `import_pending_cards`, which reads and imports them in Rust (at most 64 MB each; the web view never names a file path) through `commands::import_bytes`, the body of the ordinary card import, and the app opens the editor for the last card imported. On the computer app, `tauri-plugin-single-instance` (the first plugin registered) makes a second start pass its arguments to the running copy, which queues the cards, shows its window and emits `dorms://cards-waiting`, then the second start exits. Phone builds have none of the single-instance or window-showing code. It was checked on Linux with a real build under a virtual screen (a cold start and a forwarded second start) and by unit tests of the argument reader; it was not tried on Windows or in the Flatpak, or with a profile that has a passcode.

## Tokenator, a helper for character cards

In the character editor, the **✂️ Tokenator** button opens a panel (`TokenatorPanel.tsx`, with `lib/tokenator.ts` for the counting and the Rust command `tokenator_run` in `tokenator.rs`).

- **Counting needs no model**: tokens per field and in total (an estimate of about 4 characters a token, the same one the editor uses), a bar per field against a budget, and sentences repeated within or across fields. Budgets: Tiny 400, Small 800, Normal 1500, Large 3000 or none; the suggested one is about a fifth of the context window, rounded down to a preset.
- **Make shorter** asks the person's model to trim one field to its share of the budget (or to about 70% when there is no budget) and shows before and after, with Accept, Try again and Discard. **Help me write** drafts a chosen field from rough notes and the rest of the card, with Accept or Add to end. Nothing is applied until accepted, and the card still has to be saved.
- **It uses the person's own model** (built-in, cloud, Other API or network), so it uses that model's tokens or requests, and with a cloud model the card text goes to that provider, as in chat. It is not counted against the novel writer's daily allowance. The panel says which model it is using; with none set up, the AI buttons are off with a note and counting still works.
- **Writing other things**: the backend has a second command, `tokenator_make(kind, notes, context)`, for things that are not card fields. It asks the same model, with instructions per `kind`, and reads the answer into a structured result that the front end shows for acceptance (`TokenatorHelper.tsx` is the shared inline box: a button, a place for rough notes, a model line, then a preview with Accept, Try again and Discard). The first kind is `prompt`: the model answers in a fixed `TITLE:` / `LABEL:` / `TEXT:` form and `parse_prompt` reads it leniently (without the markers, the whole answer is the text and its first line names it; an answer with no text is refused with a message). It is offered in the Prompts menu (a ✂️ button beside New prompt) and inside the prompt editor. Accepting a draft saves it straight into Prompts (and closes the editor); nothing is saved before that. The second kind is `lorebook`: the model answers with `ENTRY:` / `KEYS:` / `TEXT:` blocks, `parse_lore_entries` reads them (numbering and bullets are ignored, an entry with no text is dropped, an entry with no keys uses its name as its key, at most 12 entries with 8 keys each, and an answer with no usable entry is refused). It is offered inside the book editor (a library lorebook or a card's own book), is told which entries already exist so it does not repeat them, and accepted entries are only ever added after the existing ones, never replacing any, and Accept saves the lorebook (or the card, for a card's own book) at once. The third kind is `playbook`: the model answers with `NAME:` / `WHAT:` / `HOW:` lines, `VALUE: name | number | 0-10 | starts 2 | note | 0=meaning, 3=meaning` (or `choice` with options, or yes/no) and `RULE: name | player says: words | trust +1; mood = cheerful` lines. `parse_playbook` builds a real `Playbook` from them (value names become safe ids; only "the player says" checks and add, subtract and set changes are written; a rule that names an unknown value or has no words or no changes is dropped; at most 10 values and 15 rules) and then runs the same `clean_playbook` check a saved playbook gets, so a draft that would not save is refused with the reason. Accept saves the playbook at once. The editor adds the drafted values and rules after the ones it has (a value with an id that exists is skipped) and only fills the name, description and instructions if they are empty. The fourth kind is `room` (`NAME:` / `KIND:` / `TEXT:`; the kind is matched to the app's room kinds, anything else is "other"), which fills the room form's name, kind and description and saves the room at once (if a choice the form needs is missing, such as whose place it is, the message says so and the draft stays). The fifth is `world` (`NAME:` / `ABOUT:` / `LORE:` then `ROOM: name | kind | description` and `LINK: a -> b` lines; at most 8 rooms, duplicate rooms dropped, links only between rooms that were written, no self-links, at most three per room). Accepting a world draft, in the selected world's panel, makes the new rooms in that world (a room with the same name there is left alone), joins them (never beyond three exits a room, and keeping a room's existing links), fills the world's description only if it is empty, and adds the lore after any lore already there. Nothing is saved or made until the person accepts, and accepting saves it (for the card helper in the character editor, it applies the field and saves the card). Tested with a fake model and the answer readers' unit tests; a real model was not tried, so how good the drafts are, and how well a small model keeps to the answer form, is unknown.
- **Limits**: counts are estimates; a very small model writes weaker suggestions; shorter can lose a detail, hence the before-and-after view. The backend and the flow are tested with a fake model; how good the suggestions are on real cards and real models was not tested.

## Status

v0.3.0 adds a real 3D viewer for VRM / VRoid models (room, idle life, physics, hands, wardrobe) and voice input. v0.2.0 added local profiles (optional passcode), a guest mode that can later be turned into a profile, per-profile data and keys, and Eject / backup / import to a verified `.dorms` file, modelled on the Eject feature of the author's Anti-Social app.

Built: everything above except battery-aware pausing and a standalone lorebook library (lorebooks are embedded in characters).
Android builds without the local engine (the OS can't run the helper binary); it uses cloud or network models. See README for the verification status of each platform.


## Holiday decoration sets (calendar-locked)

Ported from Anti-Social: the art, the collections and the rules are the same.

- **Sets**: Vibrant Pumpkin and Gobble Gobble Turkey (season `thanksgiving`), Cosy Christmas and Santa & Sparkle (`christmas`), and Hanukkah, a set per night (`hanukkah:1` to `hanukkah:8`). Each set has three nameplates, three profile backgrounds and three avatar wreaths (Hanukkah: one of each per night), and themes that wear them together.
- **Calendar** (`src/lib/decoCore.js`, `WINDOW`): Thanksgiving from 7 days before the 4th Thursday of November to 7 days after; Christmas 18 December to 6 January; Hanukkah night N from the evening of night N (the Hebrew calendar is computed in the app) until 7 days after night 8. A set opens at midnight on the device's clock. See [docs/holiday-calendar.md](docs/holiday-calendar.md).
- **Locked**: outside its window a set is a blurred teaser with the date it next opens (with the year when that is next year); its theme card is disabled and its parts are inert. This applies in every place decorations are picked: the profile, a character's and a room's. A "Next up" line shows when a set opens within six weeks.
- **What stays**: what is already worn stays on when its season ends. The window only decides what can be picked. Changing the device's date reveals a set early; that only affects looks, and is not a security feature.
- **The model**: when it chooses decorations for a character, the page passes the ids of the closed sets, which are left out of the list it is given and taken out of its answer if it names one anyway.
- **Tested**: `node tests/deco-check.mjs` (in CI) checks that every decoration has art in a moving and a still version at the right shape, that every collection and theme points at real things, the number of lit candles on each Hanukkah night, the first night of Hanukkah for 2024 to 2030, the Hebrew calendar against the system's for 1990 to 2100, and the opening and closing days of every season; Rust unit tests check the data file against the art and that a closed set is never kept from the model; the app's tests check that a closed set cannot be picked. Not tested: real appearance on every theme and screen size beyond the pictures I looked at.


## Your own decorations (.asdeco packs)

Ported from Anti-Social, the same file format, so packs made for one (or in Sudo Make Art) work in the other.

- **Kinds**: `plate` (nameplate, 240 × 44), `banner` (profile background, 1200 × 200) and `wreath` (avatar decoration, 144 × 144, with a clear circle in the middle for the picture). See [docs/asdeco-format.md](docs/asdeco-format.md) for the file, the shapes and the limits.
- **Getting them in**: Settings → Profiles → Decorations → **Add my own decorations** (also in a character's and a room's decoration picker). A `.asdeco`/`.json` pack, a lone `.svg`, a picture (`.png`, `.gif`, `.webp`, `.jpg`) or a video (`.mp4`, `.webm`, 3 MB at most) can be chosen, several at once. A preview lists what is in the files, what could not be used and why, and lets the person choose; one already in the library is shown as already added. A video's first 6 seconds become a strip of frames played by CSS; for a wreath the avatar circle is cut out of every frame. An animated picture gets a still version for when animation is off.
- **Where they live**: in the profile's own library (a table `deco_custom`), up to 120. The id is made from the art (`cp_`, `cb_` or `cw_` and ten hex digits), so the same art is the same decoration in a backup, in another profile and in another app. They join the pickers as the collection **My decorations**, are drawn like the built-in ones, and can be set for the profile, for a character and for a room. Deleting one leaves anything that wore it undressed (a missing id is simply not drawn). The model never picks them when it dresses a character.
- **Safety**: the page rebuilds every SVG from an allow-list (no scripts, `foreignObject`, event handlers, links, other CSS, DOCTYPE or custom entities; only `data:` pictures and fonts), checks the shape and size, and checks it all again each time the library is loaded; the Rust side checks the id, kind, mode, sizes and that the art looks like a picture and not a link (`clean_custom`). The art is only ever drawn as a CSS background.
- **Backups and transfer**: the library is part of the profile file, so backups and Wi-Fi transfers carry it, and an imported library keeps its ids so what the settings and characters point at still matches.
- **Export**: **My decorations → Export all as a pack** writes the library as a `.asdeco`.
- **Not built**: a "Send to Dorms" hand-over from Sudo Make Art (cards have one; decorations don't yet), and decorations in a character card file.
- **Tested**: `node tests/deco-pack-check.mjs` (in CI; Anti-Social's own checks for the importer: good files, wrong shapes, pictures, video, unsafe parts, ids), Rust unit tests (`clean_custom`, ids in the right place only, ownership, replacing the same one), and the app's tests (importing a pack, wearing one, adding the same pack twice, deleting, a made-up id refused, and a backup carrying them). Not tested: choosing a file with the real file dialog, a real video being turned into frames, a GIF's still frame (the importer checks cover the file side only), and how they look on every screen.


## Gallery

A side bar page, right after Characters, for looking at the art without chatting (`src/pages/Gallery.tsx`). The character folders only read what is already there. Folders from the computer (below) keep a list of paths, and nothing else.

- **Folders**: one art folder per character, in the character list's own order ("my order", then name). The cover is the profile picture; the line under it says how many pictures it holds and, if there is one, "gallery of N". A search (names and tags) and an "only characters with a gallery" switch narrow the list.
- **Inside a folder**: the profile picture, and the character's own gallery as a sub folder (a small fanned stack of its first pictures). A folder with no flat picture says so (a 3D VRM model is marked as one, with a note that there is no flat picture to show). Crumbs (Gallery › Name › Gallery) lead back.
- **Pictures** are images, GIFs and short clips. A clip shows its first frame and plays while the pointer is on it. Click one to see it big: left and right arrows (the keys or the buttons) move through the folder's pictures, Escape or the close button leaves, and **Open character** goes to its editor.
- **Side bar**: "Gallery" is placed after Characters by default. For someone with an order of their own it is slotted in after Characters once; it can then be dragged anywhere like any item.
- **Folders from the computer** (desktop only; hidden on Android, whose folder chooser doesn't give paths): **Add a folder from my computer** chooses a folder with the system's folder chooser and lists it under **From my computer**, per profile (up to 40; not carried in backups or transfers, because a path means nothing on another device). Its pictures (JPG, PNG, WebP, BMP, AVIF, GIF, MP4, WebM, M4V; no SVG, which can carry scripts) are shown, and its subfolders are folders inside, to 8 levels deep, with the first 5,000 pictures listed (it says so when it stops). Hidden files and folders, links and empty folders are skipped. A folder moved or deleted afterwards is marked so and can be removed.
- **What is allowed** is decided by the Rust side (`src-tauri/src/viewfolders.rs`), not the page: never a drive root, the home folder or anything above it, a hidden folder, a system folder (`/etc`, `/usr`, `/var`, the Windows and Program Files folders and the like), or the app's own data folder or anything above it (it holds the database and the key file). The web view may read a folder's files only while the folder is on the list (its read permission is granted when it is added and withdrawn when it is removed). Nothing is ever copied, written or deleted; the only thing the app stores is the path.
- **Not built**: a slideshow, thumbnails (large photos are loaded at full size, lazily), looking at the outfits of a 3D character, sorting or filtering the pictures by mood, showing the profile pictures of rooms or your own profile, and remembering which sub folder was open.
- **Tested**: the app's tests (the side bar position, the folder list and its counts, the gallery-only switch, opening a folder and its sub folder, the big viewer with its arrows and Escape, the crumbs) and the folders from the computer (adding one, the refusals, what a scan keeps and skips, the pictures being drawn, a sub folder, the viewer, removing one leaving the files alone) with generated pictures; Rust unit tests for which folders are allowed and for the scan. Not tested: video clips in the viewer, a very large library, the real folder chooser, and Windows paths.


## Comments under Gallery pictures

Each picture in the Gallery viewer has a comment section for the person's own offline notes (`src/components/PictureComments.tsx`, `src-tauri/src/gallerycomments.rs`). It works like a forum thread, with the data on this device only.

- **Any number**: there is no limit on how many comments a picture has; one comment is up to 20,000 characters, trimmed, with line breaks kept, and not empty. A comment can be written at any time, again and again, on the same picture or any other.
- **Replies**: a comment can be answered, and an answer can be answered (the thread is kept as written; the indentation stops growing after six levels). A reply has to be to a comment under the same picture. The list is oldest first. Each comment shows the name the person was playing as when it was written, how long ago, and "edited" if it was.
- **Edit and delete** the person's own comments. Deleting asks first and takes every reply under it too.
- **Keys**: Ctrl+Enter posts. While typing, the arrow keys and Escape belong to the text (Escape leaves the box) and don't flip the picture or close the viewer.
- **Which picture**: a picture is named `char:<character id>:profile`, `char:<character id>:<gallery item id>` or `disk:<full path>` (a picture from a folder on the computer; if that file is moved, its comments no longer find it). A picture with comments shows a 💬 count on its tile.
- **Housekeeping**: deleting a character, or removing a picture from its gallery, deletes the comments under it.
- **Backups and transfers** carry them. A character's id changes when a profile is imported, so the pictures' names are remapped (a gallery picture's own id stays), comments get new ids and replies are pointed at them.
- **Private**: stored in the profile's own table (`gallery_comments`), never sent anywhere; another profile on the device doesn't see them.
- **Not built**: pictures cannot be searched by what is in their comments, and comments cannot hold pictures or formatting.
- **Tested**: Rust unit tests (names of pictures, the shape of a comment, 500 comments on one picture, threads, editing, deleting with replies, the clean-up when a character goes, other profiles) and the app's tests (posting, line breaks, replies and replies to replies, editing, per-picture threads, typing not flipping the picture, 60 more comments, the length limit, a made-up parent refused, the count on the tile, deleting with replies, and comments surviving a backup with their answers). Not tested: a very long thread's scrolling and the layout on a phone.


## Adding to a gallery from a picture link

A character's gallery can also take pictures from the internet: a **picture link** box (`src/components/PictureLinkBox.tsx`) in the Gallery section of the character's editor and inside a character's folder in the Gallery page, and pasting a copied picture there. It uses the same fetcher as the avatar link (see "Avatar from a web address or the clipboard"): only `http`/`https` addresses, the app fetches the file itself (60 seconds, 40 MB at most, never a redirect from https down to http), the file's first bytes decide whether it is a picture, GIF or short video, a web page is refused with what to do instead, and the result goes through the ordinary add-a-gallery-picture path (so the usual checks, file names and limits apply). A fetch starts only when the person presses Use link. **Tested**: the app's tests (a link adds a picture to the gallery and the sub folder shows it at once; a link to a web page adds nothing). Not tested: the clipboard paste with a real browser copy, and the box inside the character editor (it is the same component).
## Avatar from a web address or the clipboard

In the character editor's Avatar section, next to **Upload**: a **picture link** box with **Use link**, and pasting a copied picture anywhere in the section.

- **Link**: only `http` and `https` addresses with a website in them (no `file:`, `ftp:`, `data:` or addresses with a name and password). The app itself fetches it (`fetch_picture`, `src-tauri/src/netpic.rs`), not the web view, so sites that don't allow other pages to read their pictures still work. Redirects are followed (never from https down to http), a site gets 60 seconds, and a file is 40 MB at most.
- **What it must be**: a JPG, PNG, WebP, GIF, MP4 or WebM. The file's first bytes decide this, not the server's label (which is often wrong). A web page is refused with what to do instead (Copy image address); anything else is refused plainly.
- **After that it is an ordinary upload**: the bytes become a file named after the address (`cat.png`) and go through the same positioning window, saving and checks as a chosen file; for a new character it waits with the rest of the card until it is saved.
- **Clipboard**: a picture copied from the internet (Copy image) and pasted in the Avatar section is used the same way. Text pasted into the link box is just text.
- **Privacy and safety**: a fetch starts only when the person presses Use link (nothing in a card or a chat can start one). A link to a device on the home network is allowed, because the person typed it; the result is only ever used as a picture.
- **Tested**: Rust unit tests (file types from their first bytes, which addresses are accepted, file names from addresses, no panic on odd escapes) and the app's tests against a small local web server (a wrongly labelled picture, a redirect, a web page, a missing file, refused addresses, and a link going through the positioning window to become the avatar). Not tested: the clipboard paste with a real browser copy, and real sites (some sites refuse downloads that don't come from a browser).
## Worlds that bring a persona, a playbook and instructions

Built (draft). A world can carry four more things besides its description and lorebooks. The rule: a world adds and never replaces a character's own.

- **Persona**: while a chat is in a room of the world, the world's persona stands in for the person's active persona (the name and description the characters are told). Everywhere else the person's own returns. Old messages keep the names they were written with.
- **Playbook**: used only when the chat did not choose one and none of its characters comes with one. The chat's own choice (including "none") and the character's playbook come first.
- **Standing instructions** (up to 4,000 characters): added to what the characters are told, with a note that a character's own instructions win if they disagree.
- **Lorebooks** already merged with the character's (unchanged).
- A persona or playbook that is not the person's own is ignored; backups and Wi-Fi transfers carry all three (the persona and playbook are pointed at the copies that arrive).
- The chat shows one line, for example "From this world (Harbour): you play Kai, playbook Trust test, 2 lorebooks, standing instructions".
- **Prompt shelf**: a world lists saved prompts (up to 30, the person's own, once each); while the chat page shows a chat in that world, the Prompts menu lists them first under "From <world>". Backups and transfers point the shelf at the copies that arrive.
- **Per-chat switch**: "Use mine here" plays as the person's own persona in that one chat (and "Use the world's" undoes it). It is kept with the chat.
- **Tested**: a unit test of the fallback order, the persona and the instructions reaching the model, and checks in the app's tests. Not tested with a real model.


## Saving a profile file on Android (fix)

On a phone, **Save my data / Eject** gives the app a `content://` address from the system's save dialog. The app used to fetch the file's bytes into the web view as one big message and have the web view write them, checking only the size. A big file between the web view and the app is not reliable on Android (the profile import already brings a file in small pieces for that reason), and a phone-made file could not be imported back even though a desktop-made one could. Now `save_export_to_uri` (`src-tauri/src/accounts.rs`) writes the file to that address from the app itself through the file plugin (so no file crosses the web view), reads it back from the same address and compares every byte (SHA-256, not just the size); if the file can't be read back or doesn't match, it says so and the export is not counted as saved (which also keeps Eject from removing the profile). Only a `content://` address is accepted there; the desktop path is unchanged. **Tested:** a unit test of the address check. **Not tested here:** the real save dialog and a real phone: that is what has to confirm the fix.
