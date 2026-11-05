#!/usr/bin/env bash
# Collects the loose Linux binaries (app + bundled engines) into the tarball that
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
tar -C "$(dirname "$stage")" -czf "$root/$out/${name}.tar.gz" "$name"
( cd "$root/$out" && sha256sum "${name}.tar.gz" | tee "${name}.tar.gz.sha256" )
