# Packaging

What the project builds itself (CI, see `.github/workflows/build.yml`) and what is handed off.

| Target | Built by CI | Where |
|---|---|---|
| Linux AppImage (x86_64) | yes | GitHub release / workflow artifacts |
| Linux `.deb`, `.rpm` | yes | same |
| Linux tarball (binaries + bundled engines) | yes | same; consumed by the AUR `-bin` and Flatpak files |
| Windows installer (NSIS, per-user, no admin) | yes | same |
| Windows portable single `.exe` | yes | same |
| Android APK (arm64 + armv7) | yes | same |
| **Flatpak** | no, hand-off | `packaging/flatpak/` |
| **AUR** (`-bin` and `-git`) | no, hand-off | `packaging/aur/` |

## Hand-off packages

The Flatpak manifest and the two AUR `PKGBUILD`s are ready for someone else to take over and submit to Flathub / the AUR.
The project owner does not want to maintain store submissions and **has given full consent for anyone to package and
publish this app** (it is MIT licensed, see `LICENSE`). You do not need to ask.

These files have **not been built or tested by the author** (no Flatpak runtime or Arch environment was available).
Expect small fixes. Things to check:

- **Flatpak**: fill in `sha256` and `commit` after a release exists; confirm the `org.gnome.Platform` runtime version
  is still current; add screenshots to the metainfo; review the OARS content rating.
- **AUR `-bin`**: replace `sha256sums=('SKIP' 'SKIP')` using the `.sha256` published beside the release tarball; generate
  `.SRCINFO` with `makepkg --printsrcinfo > .SRCINFO`.
- **AUR `-git`**: builds the engine with Vulkan; `shaderc`, `vulkan-headers` and `vulkan-icd-loader` are build deps.
  If you'd rather depend on the system `llama.cpp`, the app falls back to `llama-server` on `$PATH`.

### Why the engines are called `dorms-engine`

The app bundles its own static build of llama.cpp's server. It is installed as `dorms-engine` (CPU) and
`dorms-engine-vulkan` (GPU) next to the main binary, never as `llama-server`, so it cannot collide with a distro's own
llama.cpp package. Distro packages should install all three files in the same directory (`/usr/lib/desktop-college-dorms/`
with a symlink in `/usr/bin` is what the PKGBUILDs do; the app resolves its own real path to find the engines).

## Building packages yourself

```bash
npm ci
node scripts/build-llama.mjs            # builds the bundled engines (set SKIP_VULKAN=1 to skip the GPU one)
npx tauri build --no-bundle             # loose binary
scripts/package-linux-tarball.sh 0.1.0  # tarball for AUR -bin / Flatpak
npx tauri build --bundles appimage,deb,rpm
```

Windows single-file portable build (PowerShell):

```powershell
$env:DORMS_LLAMA_EMBED = (Resolve-Path src-tauri/binaries/dorms-engine-x86_64-pc-windows-msvc.exe).Path
npx tauri build --no-bundle -- --features portable,embed-llama
```
