## v0.13.1: lighter on your computer, plus a few things you asked for

### ⚡ Runs lighter
- **Decorations no longer eat your CPU.** With 60 characters all wearing moving nameplates, the app used about 47% CPU; now about 0.3%. In the characters list only the row under your pointer moves, nameplate motion is drawn at a gentler frame rate, and everything stands still while the app is in the background.
- **GIF room backdrops are kept light.** A GIF used as a room backdrop is saved at no more than about 854 pixels across, 8 pictures a second and 60 frames (your original file is untouched), with a still picture of its first frame. Only the backdrop of the chat in front moves; small spots (room icons, cards, the map) and the app in the background show the still. Backdrops you already have are lightened once the next time the app starts. A big GIF backdrop went from about 33% CPU to about 9% in the test. Memory use fell only a little (about 509 to 476 MiB), so the saving is mostly CPU.
- Turning off Settings → Decorations → **Animate decorations and moving backdrops** makes both stand still.

### 🎨 Fixes
- Avatar wreaths in the decoration picker were sitting about 18 pixels off-centre. They are centred on the picture now.
- The small text on the light nameplates (parchment, bubble tea) is readable.

### ✨ New
- **Right-click your profile** at the bottom of the side bar: **Quick settings**, **Switch accounts** and **Hide profile**. A hidden account leaves the account list on the start screen (nothing is deleted) and is listed in **Settings → Profile → Hidden accounts**, where it can be shown again (an account with a passcode asks for it). Hiding your only account offers to create another account or use the guest space. Hiding keeps an account out of sight; a passcode is what locks it.
- **Personas are optional.** There is no separate "default persona" any more: with none chosen, characters know you by your name. Anything written in the old "About you" box became a real persona.
- **Folders for lorebooks and playbooks**, nested four deep. Drag things in or use "Move to…", rename any time, and deleting a folder never deletes what is inside. Folders are in backups.
- **Rename the side bar sections** (Recent chats, Favorites, Most used, Picture frame): double-click the name, press ✎, or use Settings → Appearance.
- **Several picture frames**: arrows in the gaps either side of the frame flip between frames, each with its own character; at the end an arrow opens a new frame and asks who hangs in it.
- **Left arrow / Backspace go back, Right arrow goes forward** through the pages you have visited (not while you are typing or while a window is open).
- The README has new renders of everything new in 0.13.

### What I couldn't test
A real graphics card (the measurements use software rendering, so real hardware should do better), a long session with a very large library, the tray on a real Windows or Linux desktop, a real novel on a real model, and dragging folders with a real mouse or a touch screen. These were covered by the app's own tests, including end-to-end tests of the packaged Linux app, not by real play. If the app still feels slow or uses a lot of memory, large pictures and very long chats are the other things that cost memory.
