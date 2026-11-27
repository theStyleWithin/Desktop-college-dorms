# Plans for Desktop College Dorms

What is planned, what state each idea is in, what has to be decided, and a suggested order. Nothing here has dates, and none of it is a promise. The longer technical write-ups are in [SPEC.md](../SPEC.md) under the "Planned:" headings.

**Where things stand:** v0.16.0 (the Gallery Update) adds the Gallery (an art folder per character and folders from your computer, with comments under every picture) and pictures from a link. Before that, v0.15.0 (the Gobble Gobble Holiday Decor Update) adds the Thanksgiving, Christmas and Hanukkah decoration sets that open by the calendar, and your own decorations from `.asdeco` packs. Before that, v0.14.0 (the Happy Thanksgiving update: Enter Tokenator!) adds Tokenator everywhere, three starter characters, fewer Settings tabs and the Mobile College Dorms name, so items 1 and 4 below are done. The rest are still plans. Every new screen is shown as a rendered picture and approved before it is merged or released.

## 1. Tokenator (done in 0.14.0)
A helper in the character editor. It trims a card field to a token budget, or drafts a field from rough notes, using the person's own model (built-in, cloud, Other API or network).
- **Done:** the backend command (`src-tauri/src/tokenator.rs`, branch `tokenator`) with tests.
- **Left:** the panel (per-field token counts and bars against a budget, "Make shorter" with a before-and-after view, "Help me write", which model is in use), the editor button, repeated-sentence detection, tests, README and SPEC wording, and a rendered picture to approve.
- **Works without a model:** counts, repeated sentences and budgets. The AI parts need a model.
- **Caveats:** counts are estimates; very small models write weaker suggestions; shorter can lose a detail, so every change is accepted one at a time. SPEC says it counts against a daily limit, which is not built and should be reworded.

## 2. Move a profile between devices over home Wi-Fi (stage 1 built)
No more USB cable. Optional, off by default, direct between the two devices, encrypted, nothing in the cloud.
- A QR code only **pairs** the devices (address plus a one-time secret). A QR holds about 2 KB, so it cannot carry a profile. A typed short code is the fallback.
- The receiving device says what arrived and asks before adding ("Add as new" or "Replace").
- **Stages:** (1) send a whole profile, both directions; (2) send single items (character, lorebook, playbook, persona, prompt, note, world) from a "Send to phone" button, with a **QR code** tab and a Scan button on the phone; (3) "Refresh my phone", which sends only what changed (needs a record of where each item came from, or chats become duplicates); (4) true two-way sync is **not planned** (conflicts, deletions).
- **Safety:** API keys only if the box is ticked; passcodes asked for; pairings can be forgotten.
- **Likely snags:** Windows firewall, Android camera and local-network permission, routers that isolate devices.
- **Optional extra:** a short run of flashing QR codes for tiny text-only items.

## 3. Worlds that carry more (built)
A world already carries lorebooks. Plan: also a **persona**, a default **playbook** and **prompts**.
- **The rule: a world adds things and never replaces a character's own.**
- Persona: the world's persona replaces your active persona only while the chat is in that world, then yours returns; a switch ignores it for one chat; old messages keep their names.
- Playbook: order is chosen-for-the-chat, then the character's, then the world's (a fallback only).
- Lorebooks: merge; the character's entries come first if space is short.
- Prompts: both kinds, with a switch on each: a prompt shelf shown first in the Prompts menu while in the world, and standing instructions placed after the card's own system prompt (which wins).
- The chat shows one line, for example "From this world: playbook X, 2 lorebooks, persona Kai".

## 4. Fewer Settings tabs (done in 0.14.0)
**Profiles** = Profile + Decorations (Decorations folded by default). **Customization** = Chat + Appearance. Old links to the Decorations tab open Profiles with that section open. Each Chat setting saves as it changes so nothing needs the Save button. Update the tests that click tabs by name and the README mentions.

## 5. A built-in model on Android phones
- **Built, not yet proven on a real phone:** the engine (llama.cpp's server program, 64-bit ARM, CPU only) is packaged into the phone app as a native library and started like the desktop one. Next: a real phone test, then a tuned build (dot-product / i8mm) if it is too slow.
- (Before this, Android had no engine: it cannot launch a helper from the usual place, so it used cloud or network models.)
- Plan: an engine built into the app (llama.cpp as a library for 64-bit Android), the existing resumable download, and **hardware detection**: a phone that can't run a model gets **no download button**, only a plain explanation.
- Starting thresholds (guesses, to be confirmed on real phones): Llama 3.2 1B from about 6 GB of memory, 3B from about 8 GB, bigger models about 16 GB with a warning; plus the file size and about 1 GB of free storage.
- Checks on every start (free memory), a speed test, and a cost screen (storage, memory, heat, battery). Speed is unmeasured: possibly a few to a dozen words a second.
- Needs a real phone (for example a RedMagic 8 Pro) to test.

## 6. Drag a character into a chat
In a room with nobody in it, drag a character from the characters list onto the panel beside the chat to start a chat, and drag in another for a group chat. A one-to-one chat becomes a group when a second character is dropped, after asking first. Add an "Add a character" button and a menu option for touch screens and keyboards. Same rules as "Who's here" (no duplicates, a cap on group size).

## Smaller items and older backlog
- **Release notes:** the release workflow now uses `docs/release-notes-<tag>.md` as the release description when that file exists (and the generated notes when it doesn't). It has not been run on a real tag yet, so the first release after this will show whether it works.
- **Flatpak / AUR:** version and hash bump after the release files are up and only with the owner's OK.
- **Playbook "Advanced" mode** is JSON (a YAML option was dropped because adding the dependency was not approved); Lua scripting for playbooks is not included.
- **Memory and speed:** large pictures and very long chats cost memory; characters' own GIF pictures were not looked at and might cost like GIF backdrops; the tray, a real novel on a real model and a real graphics card have not been tested for real.
- **World lore** (the text written to be read) is not sent to the model.
- **Older backlog:** cross-device profile files (now covered by item 2), realistic prop holding, mouse-as-hands control.
- **Android signing:** still a throwaway key.

## Suggested order
1. Tokenator (already started, needs credits for the panel).
2. Wi-Fi transfer, stage 1 (saves the most effort for anyone using a phone).
3. Worlds that carry more, plus the Settings tab merge (both small to medium, can ship together as 0.13.2).
4. Drag a character into a chat.
5. Android built-in model (the biggest job, and needs real-phone testing).
