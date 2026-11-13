## v0.6.2: Unity packages open inside the app

### 📦 Import a `.unitypackage` as a room
Choose a Unity package (for example one from Booth) in a room's 3D model field. The app opens it, takes the room model out, puts the pictures from its materials back on, and saves it as one 3D room file. If the package has several models, you pick which one is the room.

### 🚫 Packages that can't work are refused, with the reason
- Bigger than 4 GB, or not enough free space on your device to unpack it.
- A room that would be over about 1 GB (too much for the 3D viewer).
- No single room model in it: only separate props in a Unity scene, only formats like `.blend` or `.max`, or no 3D model at all.
- Not a real Unity package, or damaged.

Nothing is kept when a package is refused, and any temporary files are removed.

### Notes
- Unity shaders and baked lighting aren't carried over, so rooms can look flatter than in VRChat.
- Rooms that are a Unity *scene* of many separate props can't be put together yet.
- I could only test with packages I made myself (and a tiny FBX room), not with a real Booth package, so please tell me if yours doesn't open.
