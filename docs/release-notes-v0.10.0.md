## v0.10.0: a characters list, galleries with mood pictures, side bar extras, and a layout that's yours

### 👥 Characters list
A members-style list on the right of the app, like Discord's.
- **Round avatar and a light** for every character. **Green** means the model that answers for them is up (a local model is always green). **Amber** means the server is up but needs attention (the key was refused, or it is limiting requests). **Red** means it can't be reached, and the line at the top says why. It's checked when you open the app, every minute, and when you change the model.
- **A status above each name**: what's on their mind, written by your model in the character's voice. Click a character for **New status**, or **Write status** to say it yourself. **Let characters write their status** does it on its own for the characters you can see. It's off by default, because it uses your model (and tokens, if it's a paid one).
- Click a character for quick **Chat** and **Edit** buttons. The arrow at the top hides the list; a small tab brings it back. It opens by itself on a wide window and hides itself on a narrow one.

### ↔ Drag the panels
Hold the wall between the side bar and the middle (or the middle and the characters list) with the left mouse button and drag to make a panel wider or narrower. Double-click the wall to put it back.

### ↕ Your own side bar order
Hold any side bar item and drag it where you want it (Alt + the up and down arrows work too). **Prompts** stays at the bottom. **Settings → Appearance** can reset the order.

All of this is kept on each device.

### 🖼 A gallery for every character
Besides their main picture, a character can now have a whole gallery of pictures, GIFs and short videos. In the character editor, under **Avatar**, there's a new **Gallery** section: add pictures (or drop them in), and remove any you don't want.

Choose how a chat uses the gallery:
- **Keep the main picture**: the gallery is just stored.
- **Change randomly after each reply**: a different picture every time they answer.
- **Match the mood of the reply**: the picture that fits how the reply feels.

### 🎭 Mood detector
For the mood mode, click the faces under each picture to say which moods it shows: calm, happy, laughing, loving, embarrassed, smug, surprised, scared, sad, angry, thinking or sleepy. After each reply the app reads it for feelings (actions like *blushes*, words like "furious", emoji) and shows the matching picture. If nothing is tagged for that mood it falls back to a calm picture, then an untagged one, then the main picture. There's a little box in the editor where you can type a reply and see which mood the app reads it as.

The picture changes on the stage and on the character's latest message, and it's remembered for each chat. A 3D character stays 3D on the stage. The detector works offline and costs no tokens.

Galleries are included in profile backups.

### 🧭 More in the side bar
The empty space under **Prompts** now holds some useful extras:
- **Recent chats**: the latest five (with Show more).
- **Favorites**: every character you've marked as a favorite, with **no limit**. Press **＋** to tick as many as you like. Click one to open your latest chat with them.
- **Most used**: the characters who've written the most messages, with their counts.
- **Picture frame**: a framed picture of the character you talked to last (the picture they're wearing in that chat). Just for looking at, and clicking it takes you back into the chat.

Fold any section away, or switch it off in **Settings → Appearance**.

### Notes
- Tried with a test server and drawn sample avatars, not with a real paid API. Please tell me if the colours or the status writing don't behave on yours.
- Statuses aren't part of profile backups (they can be written again).
- Tested with plain coloured pictures and replies I wrote for the tests, not real artwork. Please tell me if the mood detector gets a reply wrong; it's easy to teach it more words.
