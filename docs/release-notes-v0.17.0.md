## v0.17.0: The Gallery Plus Update 🖼️

The Gallery grows up, the app can live in your system tray, one character or note can be sent to your phone on its own, and the phone finally has a built-in model engine.

### 🖼️ Gallery
- **A big viewer that zooms.** Scroll or press **+ / −** to zoom a picture or GIF, drag to move it, double-click to zoom in and out, **0** to reset. Choose how it is sized: **Fit**, **1:1** (actual size), **Fill** or **Stretch** (remembered).
- **A real video player.** Play, seek, volume, speed (0.5× to 2×), loop, full screen and the video's size (with a "4K" tag), plus **Space**, **M**, **F** and **Shift+arrows**. Videos zoom and drag like pictures. How well 4K plays depends on your computer's video codecs; if a file can't be played the viewer says so (some 4K files use HEVC or AV1).
- **No more freezing on the second folder.** Pictures from your computer now show as small copies (made a few at a time as you scroll) instead of loading every full-size file, and videos in a folder don't load until you open them. If anything else in the Gallery goes wrong it now shows the error and a **Try again** button instead of a blank page.
- **Add folder** (top right) opens a menu: **Pick from desktop**, **Copy from a link…** (the app copies a picture, GIF or short video from a web address into one of your folders, or a new one) and **New gallery folder…**. A folder you make in the app is kept by the app (🗂️): add pictures from links or files, delete single pictures, or delete the whole folder (it asks first). These work on the phone too.
- **Arrange it your way.** Drag folder cards into any order (or use **↔ Arrange**, which shows ◀ ▶ on each card and also works on a touch screen, or **Alt + arrow**). A switch, **All folders in one place**, puts character folders and your own folders in one grid instead of two sections.
- **Resizable cards.** Every folder card has a ⤡ corner: drag it to make the card wider and taller (or hold **Shift** and press the arrow keys). ↺, or a double-click on the corner, puts it back.
- **The side panel can sit below the picture** (a much wider box to type in), and it can switch between **Comments** and **Talk to a character**.
- **Talk to a character about what you're looking at.** Pick any of your characters and chat with them about the picture or video on screen. They're told what it is and, for a picture, they can really see it if your model can see pictures (a smaller copy goes to the model you already chose, nothing anywhere else; untick **Let them see this picture** to keep it private). For a video they only know its name and how far in you are, never its frames. These chats stay on your device, per picture and character.

- **Add files to a character's gallery from the Gallery.** Open a character's folder and press **＋ Add files…** (copied into their gallery, the same as in the character editor) or **🔗 Link files…**.
- **Link a file instead of copying it** (desktop). A big video no longer has to be copied: the app remembers where the file is and never changes, moves or deletes it. In a character's gallery editor, **Link a file without copying…**; or switch on **Settings → Customization → Gallery files → Link files instead of copying them** so the picture chooser always links (per profile). If you move a linked file it stops showing, and each linked picture has a **📍 Relocate…** button (any other linked file from the same old folder that is in the new one follows it). Linked files aren't in profile backups.
- **Relocate a folder** that moved: the 📍 on a folder from your computer (always shown when it can't be found) points the Gallery at its new place, and the comments on its pictures come along.
- **Bigger videos.** A gallery (a character's, or a folder you make) now takes videos up to **500 MB** (pictures and GIFs stay at 60 MB), and a link can fetch up to 150 MB. Before, anything over 60 MB (40 MB in your own folders) was refused.

### 🪟 System tray (desktop)
Settings → Customization → **System tray**: put the app in the tray when you minimize the window, and/or keep it running when you close it. The icon's menu has **Open**, **Tokenator**, **Dorms (chats)**, **Characters**, **Gallery**, **Settings** and **Quit**, and clicking the icon shows or hides the window. Starting the app again always brings the window back, so a desktop that hides tray icons can't strand it. If your desktop has no tray, the setting says so and nothing is turned on (on GNOME, tray icons need the AppIndicator extension). Not on phones.

### 🎮 Add to Steam (desktop)
Settings → Customization → **Steam** → **Add to Steam** puts Desktop College Dorms in your Steam library as a non-Steam game, so you can start it from Steam (and from a Steam Deck). It adds one shortcut to the chosen Steam account's list (keeping a copy of Steam's file the first time, as `shortcuts.vdf.dorms-backup`) and changes nothing else. Steam has to be closed while it does this, because Steam rewrites that list when it closes; the app says so if Steam is running. **Update in Steam** points it at the app's new place, and **Remove from Steam** takes it out again. It finds Steam in the usual places (including the Flatpak version on Linux). Not on phones.

### 🖱️ Scroll bars that are easier to grab
The strip you click and drag is wider (16 px instead of 10), and a scroll bar's handle gets thicker and brighter when the pointer is on it or within about two thirds of an inch of it, so it is clear where to go. Under **Settings → Customization → Scroll bars**, turn **Wider scroll bars** off to go back to the thinner size (the handle still lights up near the pointer). It is a per-profile choice. Touch screens are left alone.

### 📶 Send one thing over Wi-Fi
A **📶 Send** button on a character (in its editor), a persona, a lorebook and a note sends just that one item to your other device, the same encrypted way as a whole profile and only on your home network. The other device opens **Settings → Profiles → Wi-Fi transfer… → Receive**, scans the code, sees what arrived and chooses **Add it** or **Discard**. It is always added as a new item and never replaces one you have. A persona's picture isn't sent, only its words, and a note arrives unpinned.

### 🔗 Copy from a link, in more places
Wherever you can upload a picture you can now paste a picture link and the app makes its own copy:
- **Rooms**: the backdrop (while making or editing a room) and the room gallery.
- **Worlds**: a world now has a **cover picture**, from a file or a link, chosen while making the world or later in its panel. It shows at the top of the world's overview, travels with backups and is deleted with the world.
- **Emoji and stickers**: copy one from a picture link; it is converted like an upload.
- **Gallery folders you make in the app** can be filled from links too.

### 😀 Emoji from any picture
Any size of PNG, JPG, WebP or GIF becomes an emoji or sticker: shrunk to fit and never stretched (animated GIFs stay animated).

### 📱 Phone
- **A built-in model engine.** The Android app now carries the llama.cpp engine, so the phone can download and run a model without anything else installed. It runs on the processor only, so how fast it is depends on your phone (probably a few words a second on a good one). Phones that can't run a model still don't get a download button.
- **Exporting a profile on the phone is fixed.** The file the phone saved wasn't readable (even to the phone's own import). It is now written and checked byte by byte, and a file the phone saved can be imported again.

### 👤 What belongs to a profile now stays with it
These used to be shared by everyone on the device and now belong to the profile (or the guest space) that set them: your chats with **Tokenator**, the names, layout and picture frames of the **side bar** (Recent chats, Favorites, Most used), the order of the side bar's pages, room and shelf views, outfits you hid, decoration filters, the Gallery's viewer choices and chats with characters, and the scroll bar size. The old shared settings go to the first profile that opens the app after the update, once (so check your Tokenator history if you use more than one profile).

### 📦 For Flathub and the AUR: a hand-off bundle
The release now includes **`desktop-college-dorms-packaging-0.17.0.tar.gz`**: the Flatpak manifest and the two AUR packages with this version and the Linux tarball's checksum already filled in, a `.SRCINFO` for the AUR `-bin` package, and a `HANDOFF.md` that walks someone through trying the package and submitting it. The developer doesn't submit to Flathub or the AUR; **anyone is welcome to** (the app is MIT licensed and the owner has given full consent, no need to ask). The Linux tarball now also carries the desktop entry, metadata and icons so these packages need nothing else.

### ⚠️ A warning about what is and isn't tested
The developer tests this app on **Linux (the AppImage)** and on **Android**. **These are built by the project's automated builds but the developer does not test them:**
- the **Windows** installer and the portable `.exe`,
- the **Flatpak and AUR packages**, which nobody has built yet (they come as a hand-off bundle).

If something doesn't work for you on one of these, that is probably a real problem nobody has seen yet. Please say so on the project's issues page.

### Not yet
- A **Send** button for saved prompts (the app can send them, there is just no button yet), sending playbooks and worlds over Wi-Fi, and "refresh my phone" (send only what changed).
- Gallery folders you make in the app, and the pictures in them, are **not** part of profile backups yet.
- A faster phone engine build.

### What has not been tried
These were tested with the app's own tests, not by hand: Add to Steam against a real Steam library (the tests use a pretend Steam folder), the scroll bars and their new look by hand, linking, relocating and 500 MB videos with real large files, the system tray on a real desktop, dragging and resizing with a real mouse or touch screen (the tests send the events themselves), 4K and HEVC video on real hardware, a character really seeing a picture with a model that can see pictures, Wi-Fi sending between two real devices, and the built-in phone engine and phone export on a real phone.
