## v0.6.1: bigger 3D rooms

### 🏠 No more size limit on 3D rooms
Room models of any size can now be imported (the old 300 MB limit is gone). The file is copied to your device in small pieces, so it doesn't have to fit in memory.

### 💾 It checks your free space first
When you pick a 3D room file, the app looks at how much space is free on your device. If the file can't fit, it tells you so (with both sizes) and suggests freeing some space or trying a smaller room. If it would fit but leave very little room, it warns you and lets you decide.

### 📦 Clearer message for `.unitypackage` files
Picking a `.unitypackage` now says right away that it can't be opened yet (export the room as `.fbx` or `.glb` from Unity or Blender first), instead of failing when you save.

### Notes
- Opening `.unitypackage` files directly is not supported yet.
