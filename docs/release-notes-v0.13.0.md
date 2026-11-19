## v0.13.0: decorations, emoji and stickers, worlds, and room galleries

### ✨ Profile decorations
Dress your profile with **nameplates**, **avatar wreaths**, **moving backgrounds** and a **name tag** (2 to 4 letters, a colour and a symbol), filed by collection in **Settings → Decorations**. Your nameplate shows behind your name at the bottom left. Characters can wear them too: pick them in the character's editor, or switch on **Let the model choose decorations for characters** (it picks once, from the lists, and never changes what you chose). Decorations that move can be turned off.

### 🏷 Rooms like servers
A room can have a **tag** and the same decorations a profile can wear.

### 😀 Emoji and stickers
Add your own emoji and stickers (**Settings → Emoji and stickers**), either **everywhere** or **tied to one room**. Use them in chat as `:name:` and `[sticker: name]`. The characters are told which ones exist in the room they are in, so they can use them while roleplaying.

### 🌍 Worlds
Group connected rooms into a **world**: a folder of rooms that stays apart from other worlds (rooms, "part of" links and exits never cross between worlds). Attach **lorebooks** to a world and they apply to every chat in its rooms. Each world has **background lore** to read: the **📖 Read about this world** page shows the lore, the rooms (start a dorm in any of them) and the lorebooks that apply.

### 🗺 Pathways editor
Drag to draw exits as before, now with a **Save** button: your changes stay a draft until you save, and you can discard them.

### 🖼 Room galleries
Like characters, rooms now have a **gallery**: up to 24 pictures with captions. Captions are told to the characters as details of the place, any picture can become the room's backdrop, and the pictures are copied into the app and included in backups.

### 🎲 Playbooks
A **playbook** gives a story memory and rules. It keeps **values** (trust, hunger, the weather: numbers, yes/no, text or a choice), each with a note on what it means and what a number means as it grows, and **rules** that change them before or after each reply: when you say a word, every few turns, by chance, or when a value reaches a point. A rule can even ask the model a question (up to three per playbook), with a plain-check fallback for when the model's judgment is off. The characters are told the values and what they mean, so they act on them. Lorebook entries can become available only at certain states, and a playbook can offer starting scenarios.
- Make them on the new **Playbooks** page (four starters come with the app), or paste one in as text under Advanced.
- A character can come with a playbook; each chat can use another, or none, from its **🎲 Playbook** button. One runs at a time.
- **Regenerate** replays a turn from the values before it, **Continue** doesn't move the story on, and editing a message doesn't re-run the rules.
- Playbooks, the character that comes with one, and where each chat's story stands are in backups.

### 📖 Write a novel
Next to Regenerate and Continue, **📖 Write a novel** asks what story you want (or lets the character choose a plot), its tone, point of view, number of chapters and chapter length, then writes it chapter by chapter in the chat.
- **Read at your own pace:** the chat only follows the writing if you are at the very bottom. Scroll up and it leaves you alone; a **↓ Jump to latest** button waits for you.
- **Free models:** in **Settings → Chat** enter how many requests a day your model allows (there is a "Free model (40 a day)" preset). The story is planned to fit what is left today, a few requests are kept back for chatting, and it stops after a finished chapter with a message that says why. Only requests made by the novel writer are counted.
- **Stop** drops a half-written chapter; **Keep going** continues from the last finished one. A rate-limit error waits and tries again; a daily one stops cleanly.
- **Keeps writing from the tray (Windows and Linux):** closing the window mid-novel asks whether to keep writing in the system tray. The window comes back when the novel is finished. Some Linux desktops don't show tray icons: then wait for the window to come back. Phones have no tray: keep the app open there.

### 📱 Also
Phone layout fix for the Rooms page, and refreshed README renders.

### What I couldn't test
A long roleplay through a real model (characters using emoji and stickers, choosing decorations, living in a world, following a playbook, the playbook's "ask the model" rules), a real novel on a real model (the quality of the writing and your model's real daily limits are unknown), the tray icon on a real Windows or Linux desktop, real mouse and touch screens for the pathways editor in the packaged app, and restoring an old backup into the new version by hand. These were covered by the app's own tests, including end-to-end tests of the packaged Linux app with a fake model, but not by real play.
