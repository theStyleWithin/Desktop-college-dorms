# Hand-off: put Desktop College Dorms @VERSION@ on Flathub and the AUR

The owner of this project does not want to run store submissions, and has given **full consent for anyone to package and
publish this app** (it is MIT licensed, see `LICENSE`). You do not need to ask. If you take this on, you become the
maintainer of that listing.

Everything here is already filled in for **version @VERSION@**. It has **not been built or tested by the author** (no Flatpak
runtime or Arch machine was available), so expect small fixes; please send them back as a pull request on the project's
repository if you can.

The Linux tarball everything is made from is on the release:
`https://github.com/theStyleWithin/Desktop-college-dorms/releases/tag/v@VERSION@`, file `@TARBALL@`,
sha256 `@SHA256@`. It holds the program, the two bundled engines, the license, the desktop entry, the metadata and the icons.

## What is in this folder

| Folder | What it is |
|---|---|
| `aur/desktop-college-dorms-bin/` | AUR package that installs the release's prebuilt tarball (`PKGBUILD` and `.SRCINFO`). The simple one to start with. |
| `aur/desktop-college-dorms-git/` | AUR package that builds everything from the latest source, including the engine with Vulkan (a long build). Its `.SRCINFO` has to be made on Arch (see below). |
| `flathub/` | The Flatpak manifest (`io.github.thestylewithin.DesktopCollegeDorms.yml`). |

## Arch User Repository (AUR)

1. Have an AUR account with your SSH key added (https://aur.archlinux.org).
2. Try it first, on Arch or an Arch-based system: in `aur/desktop-college-dorms-bin/` run `makepkg -si`. Check that the app starts and
   that the built-in engine works (Settings → Models → download a small model).
3. Submit it: `git clone ssh://aur@aur.archlinux.org/desktop-college-dorms-bin.git`, copy `PKGBUILD` and `.SRCINFO` in, then
   `git add PKGBUILD .SRCINFO && git commit -m "desktop-college-dorms-bin @VERSION@" && git push`.
   (If you changed the `PKGBUILD`, run `makepkg --printsrcinfo > .SRCINFO` first.)
4. For the `-git` package do the same, running `makepkg --printsrcinfo > .SRCINFO` yourself (its version is worked out from git).
   It needs `shaderc`, `vulkan-headers` and `vulkan-icd-loader` to build. If you would rather depend on the system `llama.cpp`, the app
   falls back to `llama-server` on `$PATH`.
5. For each new release: change `pkgver` and `sha256sums` (the release publishes a `.sha256` beside the tarball), regenerate `.SRCINFO`, push.

## Flathub

1. Read Flathub's submission guide: https://docs.flathub.org/docs/for-app-authors/submission
2. Try it: `flatpak-builder --user --install --force-clean build-dir flathub/io.github.thestylewithin.DesktopCollegeDorms.yml`, then
   `flatpak run io.github.thestylewithin.DesktopCollegeDorms`. Check that it starts and the built-in engine works. If the GNOME runtime
   version in the manifest (`runtime-version`) is no longer current, update it.
3. Flathub will check the metadata: run `appstreamcli validate --pedantic` on the metainfo file (it is inside the tarball under
   `share/metainfo/`) and fix what it reports. Flathub usually asks for **screenshots** in the metainfo, and has its own rules for the
   app id (this one is based on the owner's GitHub account, `io.github.thestylewithin`) and for the content rating (OARS): please review them.
4. Submit with a pull request as the guide describes (a new branch of your fork of `flathub/flathub` that adds the manifest).
5. For each new release: change the `url` and `sha256` in the manifest and open a pull request on the app's Flathub repository.

## Notes for whoever packages it

- The program expects its two engines (`dorms-engine`, `dorms-engine-vulkan`) **in the same folder as the program** and finds them from its own
  real path. They are named that way so they never collide with a distro's own `llama-server`. In the PKGBUILD they are in
  `/usr/lib/desktop-college-dorms/` with a symlink in `/usr/bin`; in the Flatpak they are in `/app/bin`.
- Video avatars need the GStreamer plugins (`gst-libav`, `gst-plugins-good`); the Flatpak GNOME runtime has them.
- API keys are stored in the system keychain through the Secret Service (the Flatpak asks for `org.freedesktop.secrets`).
- The Android app is not part of this; it is a separate file on the release.
