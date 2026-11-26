## v0.14.0: Happy Thanksgiving update: Enter Tokenator! ✂️

### ✂️ Enter Tokenator
Tokenator is a helper that uses **your own model** (built-in, cloud, Other API or network). It writes drafts and answers questions, and nothing changes until you press **Accept**.

- **A Tokenator chat in the side bar**, first in the list by default (people who already arranged their side bar get it at the top once, and it can be dragged anywhere, like every other item). It is a general helper, not a character: ask it anything, or how the app works.
- **The app's own guide is built in** (the README, spec and security notes). When a question is about the app, Tokenator looks up the few best-matching sections, so it works with a model that runs offline too, and it says which parts it read. Questions that are not about the app use none of it, so a small model's memory isn't used up. Sections about things that are only planned are marked as not built yet. The guide is from the version you have installed.
- **Pictures, gifs and videos** (a video is sent as four still frames, with no sound; a gif as its first frame) go to a model that can see them. If your model can't see pictures, or the app can't be sure, the app **does not send the file**, says so itself, and tells the model so, so it can't make up a description however many times you attach it. For a model the app can't be sure about there is a "This model can see pictures" switch.
- **Talk to it** with the microphone button (it uses the speech-to-text server you set up in Settings → Voice).
- **Personalities**: drag a saved prompt from the Prompts menu onto the chat and Tokenator talks in that style. It is still the same helper underneath, with the same honesty rules.
- **A "write it for me" box in every editor**: character card fields (shorter, or drafted from rough notes, with token counts and budgets), **prompts**, **lorebook entries**, **playbooks** (it explains what a playbook is, then drafts the values and rules), **rooms**, and **worlds** (background lore, a few rooms, and which rooms connect). Every draft is shown first. **Accept puts it where it belongs and saves it**; it only ever adds to what you already have.

### 🎁 Three starter characters
A new profile starts with **Jeeves**, **Scouter** and **HAL 9000**, so the roster isn't empty. They are added once, only to a profile with no characters and no chats, and they are ordinary characters: delete one and it never comes back. (The Scouter has an always-on safe-for-work rule; HAL is a calm, cold ship computer, as in the film.)

### 🔗 Hand a card over from Sudo Make Art
Sudo Make Art's **Send to Desktop College Dorms** (which runs `desktop-college-dorms --import-card card.png`), or simply opening a `.png` or `.json` card with the app, imports the card into the profile that is open and opens it in the card editor. If the app is already running, the second start hands its card to the open window and closes itself, so you don't end up with two copies. If no profile is open yet (the start screen, or a profile with a passcode), the card waits and is imported as soon as one is. This is for the computer app; the phone app is unchanged.

### 🧰 Easier to get around
- **Fewer Settings tabs**: 8 instead of 11. **Profiles** now holds Decorations (folded away), and **Customization** holds Chat, Appearance and Emoji & stickers. Chat and Appearance settings save as you change them. Old links to the old tabs still open the right place.
- **The Lorebooks and Notes lists can be stretched** (drag the wall at the list's edge; double-click puts it back). Folder names in them get a line of their own, so long names can be read.
- **A pull-out drawer for Prompts**: pull the handle on its bottom edge down, or the one on its right edge out, and the list grows over the side bar sections below it until you push it back.

### 📱 Mobile College Dorms
The Android app now has its own name, **Mobile College Dorms**, and its file is `MobileCollegeDorms_<version>_android.apk`. The computer app stays **Desktop College Dorms**. The app id is unchanged, so a phone that already has the app keeps its data and gets updates.

### 🐛 Fixes
- **The daily limit for novels counted a "day" as about 90 seconds**, so the allowance reset over and over. A day is a real day now.
- Tokenator's earlier instructions to the model had stray backslash characters in them. Fixed.

### What I couldn't test
A **real model** doing any of the new things (how good its drafts are, whether it can really see a picture, whether it follows a personality and the honesty rules, and whether a small model keeps to the answer format the helpers expect: the readers are forgiving and refuse an unusable answer with a message); **real video files** decoding in the app on each system; the **microphone** with a real speech-to-text server; the **phone layout** with the extra side bar item; dragging with a **real mouse or touch screen** (the tests use the keyboard and scripted drops); and the starter characters on a real model. The card hand-off was built and checked on Linux by the separate agent that made it; it wasn't tried on Windows or in the Flatpak, or with a profile that has a passcode. Everything else was covered by the app's own tests and a scripted fake model.

### Still planned (not in this release)
Moving a profile to your phone over home Wi-Fi, a built-in model on Android phones, worlds that carry their own persona, playbook and prompts, and dragging a character into a chat. See the README's "Coming soon".
