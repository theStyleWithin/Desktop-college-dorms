## v0.7.0: a decoration library (first step toward decorating your rooms)

### 🪴 Decorations
A new **Decorations** page keeps a library of 3D props: furniture, plants, food, anything you import.
- **From a Unity package:** import a pack (for example one from Booth), then tick which of its models to keep. A pack can have dozens, so there's a filter and select all. The pictures from the package's materials are put back on each prop.
- **Or a single file:** a `.glb` or `.fbx`.
- Rename or delete any decoration.

### 🔒 Sharing mark
Each decoration is **Not allowed to share** by default. Mark it **May be shared** only if the seller's terms allow passing the file on. Only shareable decorations go into an exported profile file. The export tells you which ones it left out, and ejecting a profile warns you that unshared ones are removed from the device (keep your own copy of the originals). The mark is your own declaration; the app can't check a seller's licence.

### Also
- If you import a pack of props as a room, the model chooser now points you to the Decorations page.

### Not yet
- **Placing decorations in a room** (and her walking around them) is the next step. For now the library only holds them.
- Unity shaders and baked lighting still aren't carried over.
- Tested with packages I made myself, not a real Booth pack, so please tell me if yours doesn't import.
