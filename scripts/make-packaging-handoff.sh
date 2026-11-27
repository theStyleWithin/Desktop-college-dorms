#!/usr/bin/env bash
# Makes the hand-off bundle for Flathub and the AUR: the Flatpak manifest and the AUR packages with this release's version and the
# checksum of its Linux tarball already filled in, plus step-by-step instructions for whoever submits them. The project owner does not
# submit to either place; the bundle is published beside the release so that anyone can.
#   usage: scripts/make-packaging-handoff.sh <version> <path-to-the-tarball.sha256-file> [out-dir]
set -euo pipefail
ver="${1:?version required (like 0.17.0)}"
shafile="${2:?path to the .sha256 file of the linux tarball required}"
out="${3:-dist-packages}"
root="$(cd "$(dirname "$0")/.." && pwd)"
tar_name="desktop-college-dorms-${ver}-linux-x86_64.tar.gz"
id=io.github.thestylewithin.DesktopCollegeDorms

sum="$(awk '{print $1}' "$shafile" | head -n1)"
[[ "$sum" =~ ^[0-9a-f]{64}$ ]] || { echo "the checksum in $shafile is not a sha256" >&2; exit 1; }
grep -q "$tar_name" "$shafile" || { echo "$shafile is not the checksum of $tar_name" >&2; exit 1; }

name="desktop-college-dorms-packaging-${ver}"
stage="$(mktemp -d)/${name}"
mkdir -p "$stage/aur/desktop-college-dorms-bin" "$stage/aur/desktop-college-dorms-git" "$stage/flathub"

# --- AUR -bin: version and checksum filled in, and its .SRCINFO made from the PKGBUILD itself
sed -e "s/^pkgver=.*/pkgver=${ver}/" -e "s/^pkgrel=.*/pkgrel=1/" -e "s/REPLACE_WITH_SHA256_OF_THE_TARBALL/${sum}/" \
  "$root/packaging/aur/desktop-college-dorms-bin/PKGBUILD" > "$stage/aur/desktop-college-dorms-bin/PKGBUILD"
(
  cd "$stage/aur/desktop-college-dorms-bin"
  # shellcheck disable=SC1091
  source ./PKGBUILD
  {
    echo "pkgbase = ${pkgname}"
    echo "	pkgdesc = ${pkgdesc}"
    echo "	pkgver = ${pkgver}"
    echo "	pkgrel = ${pkgrel}"
    echo "	url = ${url}"
    for a in "${arch[@]}"; do echo "	arch = ${a}"; done
    for l in "${license[@]}"; do echo "	license = ${l}"; done
    for d in "${depends[@]}"; do echo "	depends = ${d}"; done
    for d in "${optdepends[@]}"; do echo "	optdepends = ${d}"; done
    for d in "${provides[@]}"; do echo "	provides = ${d}"; done
    for d in "${conflicts[@]}"; do echo "	conflicts = ${d}"; done
    for d in "${options[@]}"; do echo "	options = ${d}"; done
    for d in "${source[@]}"; do echo "	source = ${d}"; done
    for d in "${sha256sums[@]}"; do echo "	sha256sums = ${d}"; done
    echo
    echo "pkgname = ${pkgname}"
  } > .SRCINFO
)

# --- AUR -git: builds from source; its version comes from git, so there is no checksum to fill in
cp "$root/packaging/aur/desktop-college-dorms-git/PKGBUILD" "$stage/aur/desktop-college-dorms-git/PKGBUILD"

# --- Flathub: version and checksum filled in
sed -e "s#/download/v[0-9][^/]*/desktop-college-dorms-[0-9][^/]*-linux-x86_64.tar.gz#/download/v${ver}/${tar_name}#" \
    -e "s/REPLACE_WITH_SHA256_OF_THE_TARBALL/${sum}/" \
  "$root/packaging/flatpak/${id}.yml" > "$stage/flathub/${id}.yml"

if grep -rq "REPLACE_WITH" "$stage"; then echo "a placeholder was left unfilled" >&2; grep -rn "REPLACE_WITH" "$stage" >&2; exit 1; fi

sed -e "s/@VERSION@/${ver}/g" -e "s/@SHA256@/${sum}/g" -e "s/@TARBALL@/${tar_name}/g" "$root/packaging/HANDOFF.md" > "$stage/HANDOFF.md"
cp "$root/LICENSE" "$stage/LICENSE"

case "$out" in /*) outdir="$out" ;; *) outdir="$root/$out" ;; esac
mkdir -p "$outdir"
tar -C "$(dirname "$stage")" -czf "$outdir/${name}.tar.gz" "$name"
( cd "$outdir" && sha256sum "${name}.tar.gz" | tee "${name}.tar.gz.sha256" )
echo "made $outdir/${name}.tar.gz"
