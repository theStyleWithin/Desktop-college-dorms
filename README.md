# Desktop College Dorms

[![Your app | AlternativeTo](https://alternativeto.net/static/badges/badge-compact-dark.svg)](https://alternativeto.net/software/your-app/about/?utm_source=badge&utm_medium=referral)

An offline-first desktop app (**Desktop College Dorms**) and Android app (**Mobile College Dorms**) for creating AI characters and chatting with them: one-on-one, in group
chats, or in Discord-style channels where the characters talk to each other too.

Everything lives on your device. A local model engine (llama.cpp) is **built in**, so there is nothing else to install.
Cloud APIs are optional and use your own key.

> The "dorm" theme is a skin: dorms are spaces with their own channels, like servers in Discord.

## Screenshots

Rendered from the real app with original demo characters. (Cards, chats and avatars here are made up for the screenshots.)

**New in 0.13**

| | |
|---|---|
| ![Profile decorations](docs/screenshots/desktop-decorations.png)<br>**Profile decorations**: nameplates, wreaths, moving backgrounds and a name tag for you, for your characters (or let the model dress them) and for rooms | ![Playbook panel](docs/screenshots/desktop-playbook-panel.png)<br>**Playbooks**: a story's values and rules. The characters are told the values (trust, mood, hunger...), and rules change them as you talk |
| ![Playbooks](docs/screenshots/desktop-playbooks.png)<br>**Playbooks page**: your playbooks and ready-made starters, with folders to keep them tidy | ![Playbook editor](docs/screenshots/desktop-playbook-editor.png)<br>**Playbook editor**: values, rules (checks, chances, even a question for the model), lorebooks and starting scenarios |
| ![Write a novel](docs/screenshots/desktop-novel.png)<br>**Write a novel**: beside Regenerate and Continue. Pick the plot, tone and length; read at your own pace while it keeps writing, planned to fit a free model's daily limit | ![World overview](docs/screenshots/desktop-world-overview.png)<br>**Worlds**: folders of connected rooms, with background lore to read before you dive in, and lorebooks that apply to every chat there |
| ![Folders](docs/screenshots/desktop-folders.png)<br>**Folders** for lorebooks and playbooks: nest them, drag things in, rename any time | ![Profile menu](docs/screenshots/desktop-profile-menu.png)<br>**Right-click your profile**: quick settings, switch accounts, hide an account (shown again from Settings) |
| ![Quick settings](docs/screenshots/desktop-quick-settings.png)<br>**Quick settings**: theme, text size, animation and who you are playing as | ![Side bar](docs/screenshots/desktop-side-bar.png)<br>**Side bar**: rename Recent, Favorites and Most used, and flip between several picture frames with the arrows |

Also new: **emoji and stickers** (everywhere or per room, and the characters use them), **room galleries**, moving **GIF backdrops** kept light, **Left / Right / Backspace** to go back and forward, and personas are now optional.

**Before that**

| | |
|---|---|
| ![Characters list](docs/screenshots/desktop-channel.png)<br>**Characters list** (here beside a dorm channel, where characters talk to you and to each other): a members-style list on the right with a round avatar, a presence light (green, amber or red from the model behind them) and a status bubble in each character's voice | ![Side bar](docs/screenshots/desktop-side-bar.png)<br>**Your own side bar**: drag items into your order; **Recent chats**, **Favorites** (no limit), **Most used** and a **Picture frame** fill the empty space |
| ![Gallery editor](docs/screenshots/desktop-gallery-editor.png)<br>**Character galleries**: give a character a whole gallery, tag each picture with the moods it fits, and choose fixed, random or match-the-mood | ![Mood picture in chat](docs/screenshots/desktop-gallery-chat.png)<br>**Mood pictures**: a happy reply shows the happy picture, a sad one the sad picture, detected on your device |
| ![Pathways map](docs/screenshots/desktop-pathways-map.png)<br>**Pathways map**: rooms inside rooms, and one-way exits (up to three per room) you draw by dragging from a room's handle onto another | ![Walking between rooms](docs/screenshots/desktop-go-to.png)<br>**Walk the story**: the **Go to…** menu moves the same chat into another room; a line marks the move and the characters know where they are |
| ![Picture frame chooser](docs/screenshots/desktop-picture-frame.png)<br>**Picture frame**: choose who hangs in it and they stay there until you change it | |

**More of the app**

| | |
|---|---|
| ![Home](docs/screenshots/desktop-home.png)<br>**Home**: jump back into chats, your characters at a glance | ![Library](docs/screenshots/desktop-library.png)<br>**Library**: search, tags, favorites, import cards |
| ![Direct chat](docs/screenshots/desktop-chat.png)<br>**Chat**: swipe, regenerate, continue, edit; image, GIF, video or live 3D VRM beside it | ![Editor](docs/screenshots/desktop-editor.png)<br>**Character editor**: Chub-style, with live token counts |
| ![Models](docs/screenshots/desktop-models.png)<br>**Built-in models**: sized to your computer, resumable downloads | ![Other API](docs/screenshots/desktop-other-api.png)<br>**Other API**: plug in any OpenAI- or Anthropic-style service |
| ![Light theme](docs/screenshots/desktop-light-theme.png)<br>**Themes**: dusk, midnight and a light "paper" theme | ![Welcome](docs/screenshots/desktop-welcome.png)<br>**Profiles**: local accounts with an optional passcode, or hop in as a guest |
| ![Profile settings](docs/screenshots/desktop-profile.png)<br>**Profile settings**: passcode, backup, **Eject**, delete | |

**Phone layout** (the Android app uses this same interface; shown here at phone width)

<p>
  <img src="docs/screenshots/mobile-home.png" alt="Home on a phone" width="200">
  <img src="docs/screenshots/mobile-library.png" alt="Library on a phone" width="200">
  <img src="docs/screenshots/mobile-channel.png" alt="A channel on a phone" width="200">
  <img src="docs/screenshots/mobile-settings.png" alt="Settings on a phone" width="200">
  <img src="docs/screenshots/mobile-welcome.png" alt="Profile picker on a phone" width="200">
  <img src="docs/screenshots/mobile-profile.png" alt="Profile settings on a phone" width="200">
</p>

> Regenerate them any time with `tests/e2e/screenshots.py` (see the script's header).

## Features

- **Characters** with JPG / PNG / WebP / GIF / MP4 / WebM avatars and **VRM / VRoid 3D models** (VRM 0.x and 1.0)
- **A real 3D viewer**: the character stands in a furnished dorm room (night window, rug, bed, desk, string lights) with soft shadows.
  Drag to turn, scroll or pinch to zoom, double-click to reset, and open the **big viewer** for the whole room.
  The big viewer is a real window: drag its title bar to move it, pull any edge or corner to resize it (it remembers its size), or use **theatre mode** (T) or **full screen** (F). Esc steps back one level.
  She breathes, blinks, sways and follows you with her eyes. **Soft-body physics** run from the model's own spring bones
  (hair, skirt, sleeves, ears, chest): Natural / Bouncy / Off, plus a hop button to see them move.
- **She has a life of her own** (no AI needed): when you aren't talking to her she wanders the room, scrolls her phone (and sometimes
  gets annoyed, amused or upset at something she reads), drinks coffee at her desk, sits on the bed and goes to sleep, with the time of
  day nudging what she does. The moment you start typing she stops and pays attention. Turn it off with the 🎭 button.
- **Wardrobe** (👕 button in the 3D viewer): add extra outfits for a 3D character, which are other `.vrm` files of the same character in
  different clothes, and switch between them (rename and remove too). They are saved with the character and travel in backups.
  Accessories switch on and off: **cat, dog, fox, raccoon, bunny and wolf ears and their tails**, plus glasses, hats, hair accessories,
  bags and shoes, each remembered per model. Outfits change by swapping model files; individual garments are not switched off one by one.
- **Pause / Play** (or the Space bar) freezes her in place like a video: pose, walking, breathing, blinking and physics all stop,
  while you can still orbit the camera around her.
- **Talk to her inside the scene**: the big viewer has a see-through message bar along the bottom (type, or tap the mic), and her reply
  appears in a **manga-style speech balloon above her head** as it is written, a page at a time for long replies (click to move on).
- **Voice input**: the 🎤 button in a chat listens, turns your speech into text, and sends it, so the character can hear you and answer.
  It works with any speech-to-text server that offers `/v1/audio/transcriptions`: OpenAI or Groq (cloud), or a **local Whisper server**
  such as whisper.cpp's `whisper-server` for fully offline voice. Nothing is recorded unless you press the mic; the recording goes only to the
  server you choose in Settings → Voice (https required unless it's on your own network). Voice works best with a fast cloud API or a local
  model that fits your hardware. Microphone access depends on the system: the app opts in on Linux, Windows asks you, and Android asks for the permission.
- **Virtual hands** for the 3D viewer, with three gestures (🖐 open, 👆 point, 🤏 pinch; switch with the buttons, **P** and **G**, or your controller):
  - **Pet** (open hands): stroke her head or ears and she leans into your hand, half-closes her eyes and smiles; your controller rumbles gently.
  - **Poke** (pointing finger): click a spot and she reacts to *where* you poked: a giggle for a cheek, a flick of annoyance for the forehead,
    a boop on the nose, a squeal for an ear, a startled look over her shoulder from behind, a playful poke back at her hand. Poke her again and again
    and she gets annoyed. (Only ordinary places react: face, ears, shoulders, arms, hands and back.)
  - **Tickle**: press and hold with the pointing finger and the fingers wiggle. The laugh builds the longer you go (ears, arms, shoulders, back and hands are
    ticklish), and if you catch her in the middle of a big stretch she is caught off guard and bursts out laughing.
  - **Pick up** (pinch): pinch her by the scruff and lift her into the air. She dangles from your fingertips and swings like a pendulum as you move
    your hand, and she either panics (kicking, flailing, yelling) or hangs limp and sulks. Carry her somewhere else in the room (scroll to push her
    in or out), then let go: she drops, squashes on the floor, sees stars, and carries on from wherever you put her. Silly on purpose.
  - **Controllers**: Xbox, PlayStation (DualShock 4, DualSense), Nintendo (Switch Pro, Joy-Con), Steam Controller and Steam Deck (through Steam Input)
    and most other pads work. Sticks move the hands, triggers reach in, bumpers pull back; D-pad left / up / right pick open hands / point / pinch,
    the top button cycles, the bottom button (A, Cross, B) and left button act with the right and left hand (tap to poke, hold to tickle or pinch). Hints show
    your pad's own button names, and Settings → Controller lets you rebind every one.
- **Rooms**: make a place (a living room, a rooftop, a character's bedroom) with a name, a description and a backdrop (your own
  image or a built-in scene), set a dorm in it, and the characters know where they are while the chat shows the room behind it.
  Make the room first and the dorm after ("Create & enter"), or add a room to a dorm you already have.
- **Playbooks**: give a story memory and rules. A playbook keeps **values** (trust, hunger, the weather: numbers, yes/no, text or a choice) with a note on what each means and
  what a number means as it grows, and **rules** that change them before or after each reply (when you say a word, every few turns, by chance, or when a value reaches a point;
  a rule can even ask the model a question, with a plain-check fallback). The characters are told the values and what they mean, lorebook entries can become available only at
  certain states, and a playbook can offer starting scenarios. A chat runs one playbook at a time, from the character or chosen for the chat with **🎲 Playbook**. Regenerate
  replays a turn from the values before it, Continue doesn't move the story on, and editing a message doesn't re-run the rules. Four starters come with the app.
- **Write a novel**: beside Regenerate and Continue, **📖 Write a novel** asks what story you want (or lets the character pick a plot), its tone, point of view, number of chapters
  and how long each is, then writes it chapter by chapter in the chat. Scroll and read at your own pace while it keeps writing: the view only follows if you are at the very
  bottom, and a "Jump to latest" button waits for you. For a free model with a daily allowance, enter it in **Settings → Customization** (there is a "Free model, 40 a day" preset): the story
  is planned to fit what is left today, a few requests are kept back for chatting, and it stops after a finished chapter with a message that says why. Stop and **Keep going** work
  any time; every finished chapter is saved. The app has to stay running while it writes: closing the window asks whether to **keep writing in the system tray** (the window comes back when the novel is finished; on Linux desktops without tray icons just wait for it), or close and stop. On a phone the app has to stay open.
- **Moving backdrops (GIF)** are kept light: a GIF used as a room backdrop is saved at no more than about 854 pixels across, 8 pictures a second and 60 frames (your original file is untouched), with a still picture of its first frame. Only the backdrop of the chat in front moves, and only while the app is in front: small spots (room icons, cards, the map) and the app in the background show the still. Turning off Settings → Profiles → Decorations → Animate decorations and moving backdrops makes backdrops stand still too.
- **Your profile at the bottom of the side bar**: right-click it for **Quick settings** (theme, text size, animation, who you are playing as), **Switch accounts**, and **Hide profile**. A hidden account leaves the account list on the start screen (nothing is deleted) and is listed under **Settings → Profiles → Hidden accounts**, where it can be shown again (an account with a passcode asks for it). Hiding your only account offers to create another account or use the guest space. Hiding keeps an account out of sight; a passcode is what locks it. The sections of the side bar (recent chats, favorites, most used, picture frame) can be renamed any time: double-click a section's name or press its ✎, or use Settings → Customization.
- **Folders for lorebooks and playbooks**: 📁 New folder on the Lorebooks and Playbooks pages. Folders can sit inside folders (four deep), are kept in name order, and things go in by dragging them onto a folder or with "Move to…". Rename with ✎ or by double-clicking, delete a folder without deleting what is in it (it moves up). Folders are in backups.
- **Going back and forward**: the Left arrow or Backspace goes back to the page before, and the Right arrow goes forward again (not while you are typing or while a window is open).
- **Personas are optional.** There is no separate "default persona": with none chosen, characters know you by your name. Anything written in the old "About you" box became a real persona.
- **Pathways**: build a place out of rooms. "Our house" can hold a kitchen, a living room and an attic (each with its own picture and
  description), and a room can lead on to other rooms by **exits**: one-way pathways, up to three per room (the garden gate leads to the street and the
  alley). Rooms can lead on to more rooms for as long as you keep connecting them; a room is a dead end only when you haven't connected an exit.
  In a chat, the **➜ Go to…** menu next to the message box walks the story along the room's exits (and to the rooms around it in the same place):
  it is the same chat, the same conversation, with a line marking the move. The characters are told where they are now and where they can go next.
  On the Rooms page, the **Pathways editor** shows every room as a card with a round handle: drag from the handle onto another room to draw an exit
  (an arrow; draw one back for a way home; a ✕ on the arrow removes it), and drag the cards wherever you like. Your changes wait as a draft until you press **Save pathways**
  (**Discard** puts it back the way it was saved). Dashed lines show which rooms are inside another room.
  **Worlds** are folders of connected rooms, kept apart from each other: group the rooms of a big place into a world, build more rooms into it, and attach lorebooks to it that
  apply to every chat in any of its rooms. Rooms, "part of" links and exits never cross from one world into another. Each world also has room for its **background lore**,
  written to be read: its **📖 Read about this world** page shows the lore, its rooms (start a dorm in any of them) and the lorebooks that apply, so you can read up before diving in.
  Rooms also have a **gallery**, like characters do: up to 24 pictures with captions that show what the place looks like. Captions are told to the characters as details of the room, and any picture can become the backdrop.
- **Profile decorations**: dress your profile and your characters. A **nameplate** (an animated strip behind a name), an animated **profile background** and an
  **avatar wreath** (a frame drawn around a picture), filed by collection (Classic, Kawaii Boba Tea, Lunar New Year, Anime) with filters and one-click themes, plus a
  2 to 4 letter **name tag** with a colour and a symbol. Your own show at the bottom left of the side bar, where your profile sits, and on your profile card
  (Settings → Profiles → Decorations). Each character wears theirs in the characters list and on their chat pictures; choose them in the character's editor, or switch on
  **Let the model choose decorations** and characters that have none get ones that suit who they are (never replacing a look you chose yourself). All the art is
  drawn in the app with small animations, a still version is used when animation is off or your device asks for less motion, and nothing is downloaded.
- **Your own 3D rooms**: in a room's settings, import a house or room model (`.glb`, `.gltf` or `.fbx`, or a Unity package, `.unitypackage`, for example one from Booth). It replaces the built-in 3D room in chats set in that room.
  The app finds the floor, centres the model and works out where she can walk: she wanders, uses her phone and stretches there, and steps around the furniture (a bed, desk or window are only in the built-in room). Set the size, turn and height if it doesn't sit right.
  Each model has a sharing mark, **Not allowed to share** (the default) or **May be shared**. Only a model you mark as shareable goes into an exported profile file; the room itself is always exported, and the export tells you which models it left out. The mark is your own declaration, the app can't check a seller's licence. A Unity package is opened inside the app: the room model is taken out, the pictures its materials use are put back on, and it is saved as one `.glb`. If the package has several models you choose which one is the room. A package over 4 GB, with not enough free space on the device, with a room over about 1 GB, or with no single room model in it (only separate props in a Unity scene, or only formats like `.blend`) is refused with the reason. Unity shaders and baked lighting are not carried over, so rooms look flatter than in VRChat.
- **Decorations**: a library of 3D props (furniture, plants, food…) for decorating rooms. Import a Unity package full of props and tick which models to keep, or add a single `.glb` or `.fbx`. Each decoration has a sharing mark, **Not allowed to share** (the default) or **May be shared**: only decorations marked shareable go into an exported profile (the export tells you which it left out, and ejecting removes the others from the device). Placing decorations in a room comes in the next version.
- **Text size**: a slider in the chat itself (next to the other chat options) and in Settings → Customization makes the roleplay text bigger or smaller, from 80% to 200%, with a sample. It is kept on the device.
- **Prompts**: saved pieces of text for roleplay (a mid-chat instruction, a style reminder…). **Prompts** in the side bar opens as a drop-down, so the chat you are in stays open. Press and hold a prompt and drag it into the chat to send it as your message at once; if you have already typed something, the prompt is added to your message box instead, so you can add to it and send it yourself. Click a prompt to put it in the message box (this is also how it works on a phone, where dragging isn't available). Add, edit, copy and delete prompts from the same drop-down; they are per profile and are in backups.
- **Side bar extras**: the empty part of the side bar, under Prompts, holds **Recent chats** (the latest five, with a Show more), **Favorites** (every character you've marked as a favorite, with no limit: press ＋ to tick as many as you like, or use the ★ on a character; click one to open your latest chat with them), **Most used** (the characters who have written the most messages, with their counts) and a **Picture frame** (a framed picture for looking at; click the pencil to choose who hangs in it, and they stay there until you change it, or leave it on whoever you talked to last. Clicking it opens your chat with them, showing the picture they wear in that chat). Each section can be folded away, and Settings → Customization switches any of them off. Kept on the device; hidden on a phone.
- **Character gallery**: besides their main picture, a character can have a gallery of pictures, GIFs and short videos (in the character editor, under Avatar). Choose how a chat uses it: **keep the main picture**, **change randomly after each reply**, or **match the mood of the reply**. For the mood mode, click the faces under each picture to say which moods it shows (calm, happy, laughing, loving, embarrassed, smug, surprised, scared, sad, angry, thinking, sleepy). After each reply the app reads it for feelings (actions like *blushes*, words like "furious", emoji) and shows the picture that fits; if none is tagged for that mood it falls back to a calm one, then an untagged one, then the main picture. The new picture shows on the stage and on the latest message and is remembered for that chat. A 3D character stays 3D on the stage. Galleries are part of profile backups.
- **Characters list**: a members-style list on the right (it opens by itself on a wide window; the arrow at its top hides it and a small tab brings it back). Every character has a round avatar and a light: **green** when the model that answers for them is up (a local model is always green), **amber** when the server is up but needs attention (the key was refused, or it is limiting requests), **red** when it can't be reached. It is checked when you open the app, every minute, and when you change the model. A character can also have a **status** above their name, what is on their mind, written by your model in their voice (click a character and choose New status), or by you (Write status). **Let characters write their status** lets them do it by themselves for the ones in view; it is off by default because it uses your model, and tokens on a paid one.
- **Your layout**: hold the wall between the side bar and the middle (or between the middle and the characters list) with the left mouse button and drag it to make a panel wider or narrower; double-click the wall to put it back. Hold a side bar item and drag it to put the side bar in your own order (Alt + the up and down arrows work too; Prompts stays at the bottom). Settings → Customization can reset the order. These are kept on the device.
- **Background music**: pick an MP3 (or another audio file) from your computer for a room or a dorm. It plays quietly on a loop while you
  are in a chat there, with pause, mute and volume. A dorm's own music is used instead of its room's.
- **Mechanics** (🧩 in a chat): optional story layers you switch on or off per chat. Import a `.bundle.json` pack (an affection and trust
  tracker, a relationships panel, a status panel, a phone…): its notes join the prompt, its numbers move with keywords and with what the
  character writes (hidden `[affection: add 3]` lines are removed before you read the reply), and you can watch or adjust them.
  Nothing is forced on a chat. A pack's own custom screens are not run; the app shows its values in built-in panels instead.
- **Phone mode** (📱 in a chat): the same conversation as a texting experience: a phone with message bubbles, and replies written and
  shown as short texts.
- **Character folders**: optional folders in the library, and folders can nest, so you can keep a "Canon character RP" folder with a folder per series inside it,
  and each series' characters inside that. Drag characters or folders onto a folder (or onto the path at the top), or use ⋮ → Move to folder / Move folder…; rename a folder,
  give it its own picture, or let it borrow the picture of one of the characters inside it (**Use a character's picture**). Deleting a folder never deletes anything: its characters and subfolders move up one level.
  **My order** (the default sort) lets you drag a character's card to wherever you want it, in the top level and inside any folder; the left or right half of a card decides whether it lands before or after it. On a touch screen use ⋮ → Move earlier / Move later.
- **Position your pictures**: choosing an avatar opens a window where you drag and zoom until the face is just right (with previews of the
  card, round avatar and banner). The framing is saved, can be changed later (⤧ Position), and is used everywhere the picture appears.
  Library cards are bigger too.
- **Lorebooks**: a Lorebooks library (import SillyTavern world info or a card's book), attached to any number of characters, working
  together with the book inside a card. **More initial messages** sit in the main editor, and you pick which one opens a new chat.
- **Notes**: a page for writing with no length limit, like a card's creator notes but always a click away. Saves by itself; search and pin.
- **Chub-style character editor**: tagline, in-chat name, tags, description, first message, scenario, example dialogs,
  live token counts, alternate greetings (as swipes), system prompt, post-history instructions, character's note with depth,
  and an embedded lorebook (keyword / regex triggers). Everything stays editable after creation.
- **Character card import and export** (V1, V2 and V3; JSON and PNG). Import is deliberately forgiving: wrong types and missing
  fields never cause an error, unknown fields are kept and written back, so round trips lose nothing. Tested against cards written by
  independent tools (tEXt, zTXt and ccv3 chunks, non-Latin text, loose JSON, SillyTavern-style lorebooks).
- **Chats**: one-on-one, group chats, and channels inside dorms. Swipe, regenerate, **continue** (ask the character to keep going and extend the same message), edit and delete messages.
  Turn order: take turns, random, or reply when named.
- **Bots talking to each other**: optional per channel, off by default, with a pace and an automatic stop after N bot-only turns
  so an unattended channel can't drain your battery or API credit.
- **Built-in local models** with a hardware-aware downloader (resumable), or bring any GGUF. GPU acceleration through Vulkan,
  falling back to CPU automatically.
- **Cloud and other APIs**: OpenAI-compatible, Anthropic, or **Other API**: save any number of custom endpoints
  (OpenAI-style or Anthropic-style) with your own base URL, model, auth style, extra headers and extra JSON body.
  Works with OpenRouter, Groq, Together, Mistral, DeepSeek, xAI, Ollama, LM Studio, and anything new that speaks one of those formats.
- **Local profiles, guest mode and Eject**: keep several people's (or personas') characters, chats, settings and API keys apart on one device, each with an optional passcode, or just hop in as a guest with nothing tied to a name. **Eject** saves a profile to a verified file and takes it off the device (not a delete: import the file here or on another device to bring it all back). A guest space can be turned into a profile later. Everything is local; there is no online account.
- **Privacy**: no online accounts, no analytics. Remote traffic is HTTPS (TLS via rustls) from the Rust backend, so keys never touch the web view.
  Keys go in your OS keychain, or a private file if none exists. See *Settings → Privacy*.
- **Hostile cards are contained**: an imported card's own system prompt is demoted to lower-priority notes until you trust it, and the web view can't read your database or keys. See [SECURITY.md](SECURITY.md).
- **Tokenator, a helper for character cards.** In the character editor, the **✂️ Tokenator** button shows how many tokens each part of a card uses (an estimate), against a budget (Tiny 400, Small 800, Normal 1500, Large 3000, or none; one is suggested from your context size), and lists sentences that are said more than once. **Make shorter** offers a trimmed version of a field next to the original, and **Help me write** drafts a field from your rough notes. Nothing changes on the card until you accept it, and you still save the card as usual. Tokenator also writes **prompts**: in the Prompts menu, the ✂️ button (or the "write it for me" box inside the prompt editor) turns a rough idea into a title, label and text for you to accept and edit. In the lorebook editor, **write entries for me** drafts a few entries (a name, trigger keywords and the facts) from a description of your world, and adds them after the ones you already have. In the playbook editor, **help me build this playbook** explains in plain words what a playbook is and drafts values (with ranges and what each number means) and the rules that change them; for a room, **describe this room for me** drafts a name, kind and description; and for a world, **help me map out this world** drafts background lore, a few rooms and which rooms connect, and makes the rooms for you once you accept (a room with the same name is left alone, and each room gets at most three exits). Everything is added to what you have, and nothing is saved or made until you press Accept; Accept then puts it where it belongs and saves it, with no copying and pasting. Counting works with no model; the writing helpers use your own model (built-in, cloud, Other API or network), so with a cloud model the card text goes to that provider, as it does when chatting. A very small model writes weaker suggestions, and shorter can lose a detail, so check each one.
- **Fewer Settings tabs.** Profile and Decorations are now **Profiles** (Decorations is a folded section), and Chat, Appearance and Emoji & stickers are now **Customization**. Chat and Appearance settings save as you change them.

## Coming soon

Ideas that are planned but **not built yet**. These are plans, not promises, and have no dates; the details are in [SPEC.md](SPEC.md).

- **Move your profile to your phone over home Wi-Fi.** No USB cable and no file copying: scan a QR code on your phone to pair with your computer, and your profile (or just one character, lorebook or playbook) travels directly between the two over your home network. It stays on your network, is optional, and asks before adding anything.
- **Worlds that come with their own set-up.** Give a world its own persona, a default playbook and prompts, so a place can arrive ready to play. A world adds to a character's own lorebooks, playbook and prompts and never replaces them (the persona is the one thing a world takes over, and only while you are in that world).
- **Drag a character into a chat.** In a new room with nobody in it, drag a character from the characters list onto the panel beside the chat to start talking, and drag in another to make a group chat. There will be an "Add a character" button too, for touch screens.

- **A built-in model on recent Android phones.** Download a small model (such as Llama 3.2 3B) and chat fully offline on the phone. The app checks your phone's memory, processor and free space first, and only offers models it can run (a phone that is too weak gets no download button, just an explanation). It will be slower than a cloud model, and has not been built or tested yet.

Have an idea of your own? Open an issue.

## Install

Grab a file from the [Releases](https://github.com/theStyleWithin/Desktop-college-dorms/releases) page.

| Platform | File | Notes |
|---|---|---|
| Linux (any distro, SteamOS, CachyOS, …) | `DesktopCollegeDorms_*_amd64.AppImage` | `chmod +x` and run. Bundles WebKit and the media framework |
| Debian / Ubuntu | `.deb` | |
| Fedora / openSUSE | `.rpm` | |
| Arch / CachyOS | AUR package files in [`packaging/aur`](packaging/aur) | hand-off, see below |
| Flatpak | manifest in [`packaging/flatpak`](packaging/flatpak) | hand-off, see below |
| Windows | `*_x64-setup.exe` | per-user installer, no admin needed |
| Windows (no install) | `*_x64_portable.exe` | one file; engine inside; data in a `DormsData` folder beside it |
| Android (Mobile College Dorms) | `MobileCollegeDorms_*_android.apk` | cloud / network models only (see limitations) |

**Steam Deck**: use the AppImage in Desktop Mode. The Vulkan engine uses the Deck's GPU.

First run: open **Settings → Models** and download a model (the app suggests one that fits your memory), or pick a cloud provider.
Then create or import a character and start a chat.

## Limitations (please read)

- **Android has no built-in engine yet.** Android doesn't allow launching the helper program the desktop builds use. Use a cloud provider,
  or point *Other API* at a model server on your home network (Ollama, LM Studio, or this app on your PC).
- **Passcodes are a lock, not encryption.** A profile passcode keeps other people on the same computer out of your profile inside the app. It does not encrypt files on disk, and Eject/backup files are not encrypted either (they never contain API keys or passcodes). See [SECURITY.md](SECURITY.md).
- The built-in engine needs an **AVX2 CPU** (Intel Haswell / AMD Zen or newer, which includes the Steam Deck).
- Windows portable build needs the **WebView2 runtime** (already present on Windows 11 and nearly all updated Windows 10).
- Video avatars load into memory when played (library thumbnails play on hover), so keep them reasonably small.
- Battery-aware pausing isn't implemented; the per-channel pace and turn limit are the power controls.
- **Verification status**: the Linux AppImage, the portable (single-file) build and the whole app are covered by an automated end-to-end suite
  that drives the real packaged app (card import/export, editing, GIF/video/VRM, real model chat, channels with bots, downloads, cloud and
  Other API paths, local profiles with passcodes and lockout, profile isolation, and the export / eject / import round trip, and the live 3D viewer). The **Windows installer/portable and the Android APK are built by CI but have not been run on a real device by the author**.
  If your graphics drivers can't run WebGL, the app notices an unfinished 3D attempt on the next launch and
  shows a placeholder with a "Try again" button instead of repeating a crash.
  The Flatpak and AUR files are untested hand-offs.

## Build from source

Requirements: Rust (stable), Node 20+, CMake, a C++ toolchain, and on Linux the Tauri prerequisites
(`libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libdbus-1-dev …`, see the CI workflow for the full list).
For GPU acceleration also the Vulkan SDK / `shaderc` (otherwise the CPU engine alone is built).

```bash
npm ci
node scripts/build-llama.mjs      # builds the bundled engine(s); SKIP_VULKAN=1 for CPU only
npx tauri dev                     # run in development
npx tauri build                   # installers for your OS
cargo test --workspace            # unit tests
```

End-to-end tests (Linux; needs `xvfb`, `webkit2gtk-driver`, `tauri-driver`, `ffmpeg`, `pip install selenium pillow`):

```bash
tests/e2e/fetch_assets.sh ./e2e-assets
E2E_BUNDLED_ENGINE=1 xvfb-run -a python3 tests/e2e/e2e.py <app or AppImage> e2e-assets/fixtures e2e-assets/model.gguf ./e2e-work
# without E2E_BUNDLED_ENGINE the suite uses src-tauri/binaries/dorms-engine-* (a dev build)
```

## Project layout

```
crates/dorms-core   card parsing/export (V1/V2/V3, JSON+PNG) and prompt assembly; no UI dependencies; unit tested
src-tauri           Tauri backend: SQLite storage, engine management, model downloads, streaming API clients, secrets
src                 React + TypeScript frontend (three.js + three-vrm for 3D)
scripts             build-llama.mjs (bundled engine), package-linux-tarball.sh
packaging           Flatpak manifest and AUR PKGBUILDs (hand-off), desktop/metainfo files
tests/e2e           end-to-end suite driving the real app through WebDriver
.github/workflows   CI that builds every package and runs the suite against the AppImage
```

Your data (database, images, models) is in the app data folder (Settings → About shows the path), or beside the executable
for the portable build. Copy that folder to back up or move everything.

## Packaging hand-off

The Flatpak manifest and AUR packages are ready for someone else to submit; the project owner **has given full consent** for
anyone to package and publish this MIT-licensed app, no need to ask. Details in [`packaging/README.md`](packaging/README.md).

## License

MIT, see [LICENSE](LICENSE). The bundled engine is [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT).
See [SPEC.md](SPEC.md) for the original design notes.
