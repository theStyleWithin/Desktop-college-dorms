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
| **Hand-off bundle** (`desktop-college-dorms-packaging-<version>.tar.gz`) | yes, on every release | GitHub release: the Flatpak manifest and the AUR packages with that release's version and checksum filled in, plus `HANDOFF.md` with the steps |
| **Flatpak** | no, hand-off | `packaging/flatpak/` (template), the filled-in copy is in the bundle |
| **AUR** (`-bin` and `-git`) | no, hand-off | `packaging/aur/` (templates), the filled-in copies are in the bundle |

## Hand-off packages

The Flatpak manifest and the two AUR `PKGBUILD`s are ready for someone else to take over and submit to Flathub / the AUR.
The project owner does not want to maintain store submissions and **has given full consent for anyone to package and
publish this app** (it is MIT licensed, see `LICENSE`). You do not need to ask.

**Take the bundle from the release, not these files.** Every release publishes `desktop-college-dorms-packaging-<version>.tar.gz`
(made by `scripts/make-packaging-handoff.sh` in the release workflow): the Flatpak manifest and the AUR packages with that release's
version and checksum already filled in, the AUR `-bin` `.SRCINFO`, and `HANDOFF.md`, which walks whoever submits through trying the
package and sending it to Flathub / the AUR. The copies in this folder are templates (their version and checksum are placeholders).
Everything is made from the release's Linux tarball, which holds the program, the two bundled engines, the license, the desktop entry,
the metadata and the icons, so a package needs nothing else.

These files have **not been built or tested by the author** (no Flatpak runtime or Arch environment was available).
Expect small fixes. Things to check:

- **Flatpak**: confirm the `org.gnome.Platform` runtime version is still current; add screenshots to the metainfo; review the OARS content rating
  and the app id with Flathub.
- **AUR `-bin`**: ready as it comes in the bundle (the `.SRCINFO` is made from the `PKGBUILD`); run `makepkg --printsrcinfo > .SRCINFO` again if you change it.
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
scripts/package-linux-tarball.sh 0.2.1  # tarball for AUR -bin / Flatpak
npx tauri build --bundles appimage,deb,rpm
```

Windows single-file portable build (PowerShell):

```powershell
$env:DORMS_LLAMA_EMBED = (Resolve-Path src-tauri/binaries/dorms-engine-x86_64-pc-windows-msvc.exe).Path
npx tauri build --no-bundle -- --features portable,embed-llama
```
