# Desktop College Dorms

An offline-first desktop and Android app for creating AI characters and chatting with them: one-on-one, in group
chats, or in Discord-style channels where the characters talk to each other too.

Everything lives on your device. A local model engine (llama.cpp) is **built in**, so there is nothing else to install.
Cloud APIs are optional and use your own key.

> The "dorm" theme is a skin: dorms are spaces with their own channels, like servers in Discord.

## Screenshots

Rendered from the real app with original demo characters. (Cards, chats and avatars here are made up for the screenshots.)

**Desktop**

| | |
|---|---|
| ![Home](docs/screenshots/desktop-home.png)<br>**Home**: jump back into chats, your characters at a glance | ![Library](docs/screenshots/desktop-library.png)<br>**Library**: search, tags, favorites, import cards |
| ![A channel](docs/screenshots/desktop-channel.png)<br>**Dorm channels**: characters talk to you and to each other | ![Direct chat](docs/screenshots/desktop-chat.png)<br>**Chat**: swipe, regenerate, edit; image, GIF, video or live 3D VRM beside it |
| ![Editor](docs/screenshots/desktop-editor.png)<br>**Character editor**: Chub-style, with live token counts | ![Models](docs/screenshots/desktop-models.png)<br>**Built-in models**: sized to your computer, resumable downloads |
| ![Other API](docs/screenshots/desktop-other-api.png)<br>**Other API**: plug in any OpenAI- or Anthropic-style service | ![Light theme](docs/screenshots/desktop-light-theme.png)<br>**Themes**: dusk, midnight and a light "paper" theme |

**Phone layout** (the Android app uses this same interface; shown here at phone width)

<p>
  <img src="docs/screenshots/mobile-home.png" alt="Home on a phone" width="200">
  <img src="docs/screenshots/mobile-library.png" alt="Library on a phone" width="200">
  <img src="docs/screenshots/mobile-channel.png" alt="A channel on a phone" width="200">
  <img src="docs/screenshots/mobile-settings.png" alt="Settings on a phone" width="200">
</p>

> Regenerate them any time with `tests/e2e/screenshots.py` (see the script's header).

## Features

- **Characters** with JPG / PNG / WebP / GIF / MP4 / WebM avatars and **VRM / VRoid 3D models** (live, with idle motion and blinking)
- **Chub-style character editor**: tagline, in-chat name, tags, description, first message, scenario, example dialogs,
  live token counts, alternate greetings (as swipes), system prompt, post-history instructions, character's note with depth,
  and an embedded lorebook (keyword / regex triggers). Everything stays editable after creation.
- **Character card import and export** (V1, V2 and V3; JSON and PNG). Import is deliberately forgiving: wrong types and missing
  fields never cause an error, unknown fields are kept and written back, so round trips lose nothing. Tested against cards written by
  independent tools (tEXt, zTXt and ccv3 chunks, non-Latin text, loose JSON, SillyTavern-style lorebooks).
- **Chats**: one-on-one, group chats, and channels inside dorms. Swipe / regenerate / edit / delete messages.
  Turn order: take turns, random, or reply when named.
- **Bots talking to each other**: optional per channel, off by default, with a pace and an automatic stop after N bot-only turns
  so an unattended channel can't drain your battery or API credit.
- **Built-in local models** with a hardware-aware downloader (resumable), or bring any GGUF. GPU acceleration through Vulkan,
  falling back to CPU automatically.
- **Cloud and other APIs**: OpenAI-compatible, Anthropic, or **Other API**: save any number of custom endpoints
  (OpenAI-style or Anthropic-style) with your own base URL, model, auth style, extra headers and extra JSON body.
  Works with OpenRouter, Groq, Together, Mistral, DeepSeek, xAI, Ollama, LM Studio, and anything new that speaks one of those formats.
- **Privacy**: no accounts, no analytics. Remote traffic is HTTPS (TLS via rustls) from the Rust backend, so keys never touch the web view.
  Keys go in your OS keychain, or a private file if none exists. See *Settings → Privacy*.
- **Hostile cards are contained**: an imported card's own system prompt is demoted to lower-priority notes until you trust it, and the web view can't read your database or keys. See [SECURITY.md](SECURITY.md).

## Install

Grab a file from the [Releases](https://github.com/theStyleWithin/Desktop-college-dorms/releases) page.

| Platform | File | Notes |
|---|---|---|
| Linux (any distro, SteamOS, CachyOS, …) | `DesktopCollegeDorms_*_amd64.AppImage` | `chmod +x` and run. Bundles WebKit and the media framework |
| Debian / Ubuntu | `.deb` | |
| Fedora / openSUSE | `.rpm` | |
| Arch / CachyOS | AUR package files in [`packaging/aur`](packaging/aur) | hand-off, see below |
| Flatpak | manifest in [`packaging/flatpak`](packaging/flatpak) | hand-off, see below |
| Windows | `*_x64-setup.exe` | per-user installer, no admin needed |
| Windows (no install) | `*_x64_portable.exe` | one file; engine inside; data in a `DormsData` folder beside it |
| Android | `*_android.apk` | cloud / network models only (see limitations) |

**Steam Deck**: use the AppImage in Desktop Mode. The Vulkan engine uses the Deck's GPU.

First run: open **Settings → Models** and download a model (the app suggests one that fits your memory), or pick a cloud provider.
Then create or import a character and start a chat.

## Limitations (please read)

- **Android has no built-in engine yet.** Android doesn't allow launching the helper program the desktop builds use. Use a cloud provider,
  or point *Other API* at a model server on your home network (Ollama, LM Studio, or this app on your PC).
- The built-in engine needs an **AVX2 CPU** (Intel Haswell / AMD Zen or newer, which includes the Steam Deck).
- Windows portable build needs the **WebView2 runtime** (already present on Windows 11 and nearly all updated Windows 10).
- Video avatars load into memory when played (library thumbnails play on hover), so keep them reasonably small.
- Battery-aware pausing isn't implemented; the per-channel pace and turn limit are the power controls.
- **Verification status**: the Linux AppImage, the portable (single-file) build and the whole app are covered by an automated end-to-end suite
  that drives the real packaged app (card import/export, editing, GIF/video/VRM, real model chat, channels with bots, downloads, cloud and
  Other API paths, and the live 3D viewer). The **Windows installer/portable and the Android APK are built by CI but have not been run on a real device by the author**.
  If your graphics drivers can't run WebGL, the app notices an unfinished 3D attempt on the next launch and
  shows a placeholder with a "Try again" button instead of repeating a crash.
  The Flatpak and AUR files are untested hand-offs.

## Build from source

Requirements: Rust (stable), Node 20+, CMake, a C++ toolchain, and on Linux the Tauri prerequisites
(`libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libdbus-1-dev …`, see the CI workflow for the full list).
For GPU acceleration also the Vulkan SDK / `shaderc` (otherwise the CPU engine alone is built).

```bash
npm ci
node scripts/build-llama.mjs      # builds the bundled engine(s); SKIP_VULKAN=1 for CPU only
npx tauri dev                     # run in development
npx tauri build                   # installers for your OS
cargo test --workspace            # unit tests
```

End-to-end tests (Linux; needs `xvfb`, `webkit2gtk-driver`, `tauri-driver`, `ffmpeg`, `pip install selenium pillow`):

```bash
tests/e2e/fetch_assets.sh ./e2e-assets
E2E_BUNDLED_ENGINE=1 xvfb-run -a python3 tests/e2e/e2e.py <app or AppImage> e2e-assets/fixtures e2e-assets/model.gguf ./e2e-work
# without E2E_BUNDLED_ENGINE the suite uses src-tauri/binaries/dorms-engine-* (a dev build)
```

## Project layout

```
crates/dorms-core   card parsing/export (V1/V2/V3, JSON+PNG) and prompt assembly; no UI dependencies; unit tested
src-tauri           Tauri backend: SQLite storage, engine management, model downloads, streaming API clients, secrets
src                 React + TypeScript frontend (three.js + three-vrm for 3D)
scripts             build-llama.mjs (bundled engine), package-linux-tarball.sh
packaging           Flatpak manifest and AUR PKGBUILDs (hand-off), desktop/metainfo files
tests/e2e           end-to-end suite driving the real app through WebDriver
.github/workflows   CI that builds every package and runs the suite against the AppImage
```

Your data (database, images, models) is in the app data folder (Settings → About shows the path), or beside the executable
for the portable build. Copy that folder to back up or move everything.

## Packaging hand-off

The Flatpak manifest and AUR packages are ready for someone else to submit; the project owner **has given full consent** for
anyone to package and publish this MIT-licensed app, no need to ask. Details in [`packaging/README.md`](packaging/README.md).

## License

MIT, see [LICENSE](LICENSE). The bundled engine is [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT).
See [SPEC.md](SPEC.md) for the original design notes.
