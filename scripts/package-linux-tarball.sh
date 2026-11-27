#!/usr/bin/env bash
# Collects the loose Linux binaries (app + bundled engines), the license, the desktop entry, the metadata and the icons into the tarball that
# the AUR -bin package and the Flatpak manifest consume.
#   usage: scripts/package-linux-tarball.sh <version> [out-dir]
set -euo pipefail
ver="${1:?version required}"
out="${2:-dist-packages}"
root="$(cd "$(dirname "$0")/.." && pwd)"
triple="x86_64-unknown-linux-gnu"
name="desktop-college-dorms-${ver}-linux-x86_64"
stage="$(mktemp -d)/${name}"
mkdir -p "$stage" "$root/$out"
install -m755 "$root/target/release/desktop-college-dorms" "$stage/desktop-college-dorms"
install -m755 "$root/src-tauri/binaries/dorms-engine-${triple}" "$stage/dorms-engine"
install -m755 "$root/src-tauri/binaries/dorms-engine-vulkan-${triple}" "$stage/dorms-engine-vulkan"
install -m644 "$root/LICENSE" "$stage/LICENSE"
# the desktop entry, metadata and icons travel in the tarball too, so a package made from it needs nothing else
id=io.github.thestylewithin.DesktopCollegeDorms
install -Dm644 "$root/packaging/linux/$id.desktop" "$stage/share/applications/$id.desktop"
install -Dm644 "$root/packaging/linux/$id.metainfo.xml" "$stage/share/metainfo/$id.metainfo.xml"
install -Dm644 "$root/packaging/linux/icons/256.png" "$stage/share/icons/hicolor/256x256/apps/$id.png"
install -Dm644 "$root/packaging/linux/icons/512.png" "$stage/share/icons/hicolor/512x512/apps/$id.png"
tar -C "$(dirname "$stage")" -czf "$root/$out/${name}.tar.gz" "$name"
( cd "$root/$out" && sha256sum "${name}.tar.gz" | tee "${name}.tar.gz.sha256" )
