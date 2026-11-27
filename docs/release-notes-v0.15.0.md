## v0.15.0: Gobble Gobble Holiday Decor Update 🦃🎄🕎

### 🎨 Holiday decorations that open by the calendar
New profile decorations for Thanksgiving, Christmas and Hanukkah. They open on the right days **every year**, with nothing to download and nothing to update. Each set has nameplates, profile backgrounds and avatar wreaths, and themes that wear them together. They work for your profile, your characters and your rooms, and they are the same art and the same calendar rules as in the author's other app, Anti-Social.

| Set | Open from | Open until |
|---|---|---|
| **Vibrant Pumpkin** and **Gobble Gobble Turkey** (Thanksgiving) | 7 days before the 4th Thursday of November | 7 days after it |
| **Hanukkah**, night 1 to night 8 (a set for every night, with that night's candles lit) | the evening of that night | 7 days after night 8 |
| **Cosy Christmas** and **Santa & Sparkle** | 18 December | 6 January |

This year: Thanksgiving is open now until Thu 3 Dec. Hanukkah night 1 opens Fri 4 Dec (night 8 on Fri 11 Dec) and the nights stay open until Fri 18 Dec. Christmas runs from Fri 18 Dec to 6 Jan 2027. In 2027 the first night of Hanukkah is 24 December: the Hebrew calendar is worked out inside the app (and checked against the system's calendar for every year from 1990 to 2100).

- Outside its window a set is a **blurred teaser with the date it opens**, and it can't be picked. A **"Next up"** line shows when something opens within six weeks.
- A set opens at midnight, on your device's clock. **What you are already wearing stays on** when its season ends; the window only decides what you can pick.
- When the model dresses a character for you, it is never offered a closed set.
- Changing your device's date reveals a set early. That only affects how things look.
- The rules are written up in [docs/holiday-calendar.md](docs/holiday-calendar.md).

### 🖌️ Your own decorations
Under **Settings → Profiles → Decorations**, **Add my own decorations** brings in nameplates, profile backgrounds and avatar wreaths from a **`.asdeco` pack** (the same format Anti-Social and Sudo Make Art use), or from a lone SVG, PNG, GIF, WebP, JPEG or a short MP4/WebM clip. The app picks the kind from the picture's shape, and a video becomes a strip of frames.

- You see what is in the file, what couldn't be used and why, and choose what to add. They join the pickers as **My decorations** (for your profile, your characters and your rooms).
- **My decorations** lists them, deletes them and **exports them all as a pack** you can share. Only share art you made or have permission to share.
- They are private to your profile and **travel with backups and Wi-Fi transfers**. Up to 120 in your library, 40 per pack.
- **Safe by design**: every file is rebuilt from an allow-list on the way in (no scripts, no links, nothing that can run), checked again whenever it is loaded, and only ever drawn as a picture. The format is in [docs/asdeco-format.md](docs/asdeco-format.md).

### Not yet
- A "send to Dorms" hand-over of decoration packs from Sudo Make Art (cards already have one).
- The model doesn't pick your own decorations when it dresses a character.

### What has not been tried
The sets and your-own-decorations were tested with the app's own tests and rendered pictures. Not tried: choosing a file with the real file dialog, a real video being turned into frames, a GIF's still frame, and everything on a real phone. The Android in-app model and Wi-Fi transfer between real devices are still untested on hardware, as before.
