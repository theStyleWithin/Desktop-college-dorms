# Desktop College Dorms: Spec

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

## Text size (v0.7.1)

- The size of chat text is a multiplier (0.8 to 2, in steps of 0.05) stored on the device in local storage (it differs between a phone and a desktop, so it is not part of the profile or its backups) and exposed as the CSS variable
  `--chat-scale`. Message text, the message editor, the composer and the texting-style bubbles scale with it; the rest of the interface does not. One slider is in the chat header, another (with a sample) in Settings → Appearance; they stay in step.

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

## Status

v0.3.0 adds a real 3D viewer for VRM / VRoid models (room, idle life, physics, hands, wardrobe) and voice input. v0.2.0 added local profiles (optional passcode), a guest mode that can later be turned into a profile, per-profile data and keys, and Eject / backup / import to a verified `.dorms` file, modelled on the Eject feature of the author's Anti-Social app.

Built: everything above except battery-aware pausing and a standalone lorebook library (lorebooks are embedded in characters).
Android builds without the local engine (the OS can't run the helper binary); it uses cloud or network models. See README for the verification status of each platform.
