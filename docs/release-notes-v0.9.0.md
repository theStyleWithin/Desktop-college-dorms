## v0.9.0: a characters list, and a layout that's yours

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

### Notes
- Tried with a test server and drawn sample avatars, not with a real paid API. Please tell me if the colours or the status writing don't behave on yours.
- Statuses aren't part of profile backups (they can be written again).
