# Handoff: Desktop College Dorms (branch `crossdevice-and-props`, PR #14)

Repo: theStyleWithin/Desktop-college-dorms. Tauri 2 + React/TS + Rust, three.js VRM viewer. Everything below is committed on this branch.
The owner publishes releases themselves (GitHub Releases UI) and wants to be told when release builds/assets are up. **Never merge PR #13 or #14 without the owner's explicit "merge it".** Use `gh api` (REST) only; GraphQL is blocked. Draft -> ready: `POST /repos/{o}/{r}/pulls/N/ccr/ready_for_review`.

## What is on this branch (on top of PR #13, v0.5.1)
- Mouse as the virtual hands (Shift/right button = left hand, left+right click = pinch), keys 1-4 pick gestures, tickle tool, gamepad `tickle` binding.
- Camera height (Q/E), free roam (C, arrow keys, not WASD).
- Cross-device profile import (staged base64 chunks, no file-picker filter, cloud-provider fallback when no local engine). **Not tested on a real phone.**
- Realistic holds: phone palm-up with screen toward her eyes; mug held by the handle with fingers through it (`PHONE_OFF`, `MUG_OFF`, `tightR` in `src/lib/npc.ts`).
- Character cards: drag to reorder ("My order" sort), `order` field; folders can borrow a character's picture (`cover_char`).
- **Imported 3D rooms** (.glb/.gltf/.fbx): room settings -> import, size/turn/height, per-room sharing mark (default NOT shareable). Only shareable models go into exported profiles; export reports `withheld_rooms`; eject warns that unshared models are removed. Loader + walkable-layout analysis: `src/lib/roomModel.ts`; layout hooks: `LAYOUT/applyLayout` in `src/lib/room.ts`, `rebuildGrid/randomSpot` in `src/lib/npc.ts`; backend: `set_room_model`, `clear_room_model`, `set_room_model_cfg` in `extras.rs`, export/import in `accounts.rs`.

## Open problem to fix first
CI job `e2e-linux` failed on a8fe5b2 (and will on later commits): check **"the chat's side panel shows the live 3D character"** (tests/e2e/e2e.py ~line 1045): `.stage .vrm-box[data-ready="1"]` never appears in the real app (WebKitGTK) within 30 s. It passed on PR #13 (`poke-gestures`), so a change in dccfe84/a8fe5b2 broke it. The plain dev viewer works in Chromium and in WebKitGTK (tests/dev/wk.py), so look at what the real chat page does differently (props to `Art`/`VrmViewer`, `scene` prop, `sceneKey` effect dependency, `roomScene(room)`, first-run guard `glAllowed`). Get the CI log: `gh api repos/theStyleWithin/Desktop-college-dorms/actions/jobs/<id>/logs`. Do not skip the test to get green.

## Still to do
1. Fix the e2e failure above, get CI green on the current head.
2. e2e tests for: mouse hand/Shift/chord, keys 1-4 + tickle tool, roam/height keys, gamepad tickle binding, staged import round trip. (Card reorder, folder picture and 3D-room import/sharing/export tests were already added to tests/e2e/e2e.py but have not yet run green in CI.)
3. Version bump (e.g. 0.6.0): package.json, package-lock.json, tauri.conf.json, both Cargo.toml, Cargo.lock, metainfo.xml. Release notes (see v0.5.0 style). Update SPEC.
4. Mark PR #14 ready for review when green; then ask the owner before merging #13 and #14. Offer Flatpak/AUR version+hash bump after they publish; PRs #10/#7 are open but their content already shipped (ask before closing). Android still uses a throwaway signing key.
5. Be honest in reports: cross-device import, real controllers, real Booth assets and the phone were never tried on real hardware.

## Local testing notes
- Disk is tight: a full `tauri build --debug` can fill it; delete `src-tauri/target/{release,debug/incremental}` and caches first.
- Viewer harness (Chromium + swiftshader): `npx vite --port 5199`, then `python3 tests/dev/cors_srv.py <dir with m.vrm and room.glb> 8099` (edit the path/port as needed), then `node tests/dev/roomtest.js out.png`, `roomwalk.js` (walks her in the test room), `proptest.js` (hand/prop renders), `ptest.js`/`padtest.js` (pointer/gamepad). Test room: `python3 tests/e2e/mkroom.py room.glb`. `viewer-dev.html?src=<vrm>&room=<glb>&ext=glb&rscale=1&rrot=0&ry=0`.
- Full e2e needs the debug build, Xvfb, tauri-driver: see `tests/e2e/e2e.py` header and `.github/workflows`.
