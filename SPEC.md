# Desktop College Doorms: Spec

An offline-first desktop app for creating AI characters and chatting with them one-on-one, in groups, or in Discord-style channels where characters talk to each other. Everything lives on the user's machine. Cloud APIs are optional.

The "dorm" theme is a skin, not a mechanic: rooms, a dorm hall, a common room. It was not the original intent, but it works as a visual identity (see UI).

## Decisions

| Area | Decision |
|---|---|
| Shell | **Tauri** (Rust backend, web frontend) |
| Frontend | TypeScript + React or Svelte (decide at scaffold time), three.js for 3D |
| Storage | Local SQLite for chats and characters, character images and media as files in the app data dir |
| Local models | **llama.cpp bundled in v1** as a Tauri sidecar, so install is plug and play with no external software. In-app model downloader (GGUF files) with hardware detection picks a sensible default size. Ollama or any OpenAI-compatible local server stays supported as an optional advanced endpoint |
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
- **Background bot-to-bot chat is optional and off by default**, because it drains PC power. Per-channel toggle for auto-chat, plus a speed/interval setting and a "pause when on battery" option. By default characters only reply while the user is active in the app.

## Open questions

- React or Svelte for the frontend? Recommendation: **React**. Larger ecosystem, and the best-supported 3D/VRM tooling (react-three-fiber) is React-based. Pending the user's go-ahead.
