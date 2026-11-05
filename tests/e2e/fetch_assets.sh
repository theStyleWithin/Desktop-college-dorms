#!/usr/bin/env bash
# Downloads/creates everything the end-to-end suite needs (no secrets involved).
#   usage: tests/e2e/fetch_assets.sh <out-dir>
# Needs: python3 + Pillow, ffmpeg, git, curl.
set -euo pipefail
out="$(mkdir -p "${1:?out dir}" && cd "$1" && pwd)"
here="$(cd "$(dirname "$0")" && pwd)"

python3 "$here/make_fixtures.py" "$out/fixtures"

ffmpeg -loglevel error -y -f lavfi -i testsrc=size=320x480:rate=15 -t 1 -pix_fmt yuv420p "$out/fixtures/clip.mp4"
ffmpeg -loglevel error -y -f lavfi -i testsrc=size=320x480:rate=15 -t 1 -c:v libvpx -b:v 300k "$out/fixtures/clip.webm" || true

# A real VRM 1.0 sample model from the three-vrm project.
tmp="$(mktemp -d)"
git clone -q --depth 1 --filter=blob:none --sparse https://github.com/pixiv/three-vrm "$tmp/tv"
git -C "$tmp/tv" sparse-checkout set packages/three-vrm/examples/models
cp "$tmp/tv/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm" "$out/fixtures/sample.vrm"

# A small instruction-tuned model (145 MB) with a normal context window, for the real chat path.
curl -fsSL -o "$out/model.gguf" \
  "https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/main/SmolLM2-135M-Instruct-Q8_0.gguf"
echo "assets ready in $out"
