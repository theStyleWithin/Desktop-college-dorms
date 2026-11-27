#!/usr/bin/env bash
# Checks that the Flathub / AUR hand-off bundle comes out complete, with nothing left to fill in. Needs no built app: it uses a stand-in tarball.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
ver="$(node -p "require('$root/package.json').version")"
name="desktop-college-dorms-${ver}-linux-x86_64"
mkdir -p "$tmp/$name"; echo stand-in > "$tmp/$name/desktop-college-dorms"
tar -C "$tmp" -czf "$tmp/$name.tar.gz" "$name"
( cd "$tmp" && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256" )
sum="$(awk '{print $1}' "$tmp/$name.tar.gz.sha256")"
"$root/scripts/make-packaging-handoff.sh" "$ver" "$tmp/$name.tar.gz.sha256" "$tmp/out" > /dev/null 2>&1 || { "$root/scripts/make-packaging-handoff.sh" "$ver" "$tmp/$name.tar.gz.sha256" "$tmp/out"; exit 1; }
b="desktop-college-dorms-packaging-${ver}"
mkdir "$tmp/x"; tar -C "$tmp/x" -xzf "$tmp/out/$b.tar.gz"
d="$tmp/x/$b"
fail() { echo "FAIL: $1" >&2; exit 1; }
for f in HANDOFF.md LICENSE aur/desktop-college-dorms-bin/PKGBUILD aur/desktop-college-dorms-bin/.SRCINFO aur/desktop-college-dorms-git/PKGBUILD flathub/io.github.thestylewithin.DesktopCollegeDorms.yml; do [ -f "$d/$f" ] || fail "missing $f"; done
grep -rq "REPLACE_WITH\|@VERSION@\|@SHA256@\|@TARBALL@" "$d" && fail "a placeholder is left"
grep -q "^pkgver=${ver}$" "$d/aur/desktop-college-dorms-bin/PKGBUILD" || fail "PKGBUILD version"
grep -q "sha256sums=('${sum}')" "$d/aur/desktop-college-dorms-bin/PKGBUILD" || fail "PKGBUILD checksum"
grep -q "	pkgver = ${ver}" "$d/aur/desktop-college-dorms-bin/.SRCINFO" || fail ".SRCINFO version"
grep -q "	sha256sums = ${sum}" "$d/aur/desktop-college-dorms-bin/.SRCINFO" || fail ".SRCINFO checksum"
grep -q "	source = ${name}.tar.gz::https://github.com/theStyleWithin/Desktop-college-dorms/releases/download/v${ver}/${name}.tar.gz" "$d/aur/desktop-college-dorms-bin/.SRCINFO" || fail ".SRCINFO source"
grep -q "^pkgname = desktop-college-dorms-bin" "$d/aur/desktop-college-dorms-bin/.SRCINFO" || fail ".SRCINFO pkgname"
bash -n "$d/aur/desktop-college-dorms-bin/PKGBUILD" || fail "bin PKGBUILD is not valid shell"
bash -n "$d/aur/desktop-college-dorms-git/PKGBUILD" || fail "git PKGBUILD is not valid shell"
python3 - "$d/flathub/io.github.thestylewithin.DesktopCollegeDorms.yml" "$ver" "$sum" "$name" <<'PY' || fail "Flatpak manifest"
import sys, yaml
m = yaml.safe_load(open(sys.argv[1])); ver, sum_, name = sys.argv[2:5]
assert m["app-id"] == "io.github.thestylewithin.DesktopCollegeDorms" and m["command"] == "desktop-college-dorms"
src = m["modules"][0]["sources"]
assert len(src) == 1 and src[0]["type"] == "archive", src
assert src[0]["url"] == f"https://github.com/theStyleWithin/Desktop-college-dorms/releases/download/v{ver}/{name}.tar.gz", src[0]["url"]
assert src[0]["sha256"] == sum_ and src[0]["strip-components"] == 1
PY
# what the manifest and the PKGBUILD install must be what the tarball script puts in the tarball
for f in desktop-college-dorms dorms-engine dorms-engine-vulkan LICENSE share/applications share/metainfo share/icons/hicolor/256x256/apps share/icons/hicolor/512x512/apps; do
  grep -q "$f" "$root/packaging/aur/desktop-college-dorms-bin/PKGBUILD" || fail "PKGBUILD does not install $f"
  grep -q "$f" "$root/packaging/flatpak/io.github.thestylewithin.DesktopCollegeDorms.yml" || fail "the manifest does not install $f"
done
for f in packaging/linux/io.github.thestylewithin.DesktopCollegeDorms.desktop packaging/linux/io.github.thestylewithin.DesktopCollegeDorms.metainfo.xml packaging/linux/icons/256.png packaging/linux/icons/512.png LICENSE; do [ -f "$root/$f" ] || fail "$f is missing from the repository"; done
grep -q "share/metainfo" "$root/scripts/package-linux-tarball.sh" && grep -q "share/icons/hicolor/512x512" "$root/scripts/package-linux-tarball.sh" || fail "the tarball script does not carry the desktop files"
grep -q "<release version=\"${ver}\"" "$root/packaging/linux/io.github.thestylewithin.DesktopCollegeDorms.metainfo.xml" || fail "the metainfo has no release entry for ${ver}"
# a wrong checksum file is refused
echo "0000 wrong" > "$tmp/bad.sha256"
if "$root/scripts/make-packaging-handoff.sh" "$ver" "$tmp/bad.sha256" "$tmp/out2" > /dev/null 2>&1; then fail "a bad checksum file was accepted"; fi
echo "packaging hand-off bundle ok ($ver)"
