## v0.12.0: exits and a pathways map for your rooms, and a picture frame you choose

### ➜ Exits: rooms that lead somewhere
A room can now lead on to other rooms by **exits**: one-way pathways, **up to three per room**. The garden gate can lead to the street and the alley; the alley can lead on to somewhere else, and so on for as long as you keep connecting rooms. A room is a dead end only when you haven't connected an exit from it.
- Choose a room's exits in the room form (**Exits**), or draw them on the map below.
- Each exit goes **one way**. For a way back, give the other room an exit too.
- In a chat, the **➜ Go to…** menu now shows the room's **Exits**, then the rooms around it (the place it is part of, the rooms inside it and its neighbours there), instead of every room. A room with nothing to lead to says **No way on from here**. A chat that isn't in any room yet can still enter any room.
- The characters are told where they can go from where they stand, so they can say "let's go through the gate".
- Doorways from v0.11.0 keep working: each one became two exits (one each way). A room that already has more than three keeps them until you change its exits.

### 🗺 Pathways map
On the **Rooms** page, switch from **Cards** to **Pathways map**. Every room is a card with a round handle under it:
- **Drag from the handle onto another room** to give the first room an exit there. It is drawn as an arrow.
- **Click the × on an arrow** to remove it. Two rooms that lead to each other show two curved arrows.
- **Drag the cards** wherever you want them. The layout is kept on this device.
- Dashed lines show which rooms are inside another room.
- A room that already has three exits tells you to remove one first.

### 🖼 Choose who hangs in the picture frame
The side bar's **Picture frame** no longer just follows your latest chat. Click the **✎ pencil** on the frame and choose any character: they stay in the frame until you change it, however many chats you start with others. Clicking the frame opens your chat with them (or starts one). Prefer the old way? Choose **Whoever I talked to last**. The choice is kept on each device.

### What I couldn't test
A real mouse in the packaged app and touch screens for the map, a long roleplay through a real model while walking through rooms, and restoring a backup that has exits in it. Drawing, limits, removing, moving and saving were tested with a real mouse in a browser and in the app's own tests.
