"""Builds a small test 3D room as a .glb (pure Python): a floor, four walls with a doorway, a ceiling, a table and a bed.
The whole thing sits away from the origin on purpose, so the app has to centre it. Units are metres."""
import json, struct, sys


def _box(w, h, d, cx, cy, cz):
    x0, x1, y0, y1, z0, z1 = cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2, cz - d / 2, cz + d / 2
    # six faces, each with its own normal, wound counter-clockwise seen from outside
    faces = [
        ((0, 1, 0), [(x0, y1, z0), (x0, y1, z1), (x1, y1, z1), (x1, y1, z0)]),
        ((0, -1, 0), [(x0, y0, z1), (x0, y0, z0), (x1, y0, z0), (x1, y0, z1)]),
        ((0, 0, 1), [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]),
        ((0, 0, -1), [(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)]),
        ((1, 0, 0), [(x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1)]),
        ((-1, 0, 0), [(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)]),
    ]
    pos, nor, idx = [], [], []
    for n, vs in faces:
        b = len(pos)
        pos += vs; nor += [n] * 4
        idx += [b, b + 1, b + 2, b, b + 2, b + 3]
    return pos, nor, idx


def room_glb(ox=12.0, oz=7.0):
    """Returns the bytes of the model. Floor top is at height 0.4 (a raised floor), so finding the floor level matters."""
    fy = 0.4
    parts = [  # (name, colour, w,h,d, cx,cy,cz)
        ("floor", (0.55, 0.38, 0.22), 8, 0.1, 6, ox, fy - 0.05, oz),
        ("wall-back", (0.8, 0.78, 0.9), 8, 2.8, 0.1, ox, fy + 1.4, oz - 3),
        ("wall-left", (0.8, 0.78, 0.9), 0.1, 2.8, 6, ox - 4, fy + 1.4, oz),
        ("wall-right", (0.8, 0.78, 0.9), 0.1, 2.8, 6, ox + 4, fy + 1.4, oz),
        ("wall-front-a", (0.8, 0.78, 0.9), 3, 2.8, 0.1, ox - 2.5, fy + 1.4, oz + 3),   # a doorway between the two front pieces
        ("wall-front-b", (0.8, 0.78, 0.9), 3, 2.8, 0.1, ox + 2.5, fy + 1.4, oz + 3),
        ("ceiling", (0.95, 0.95, 0.95), 8, 0.1, 6, ox, fy + 2.85, oz),
        ("table", (0.4, 0.25, 0.15), 1.4, 0.75, 0.9, ox - 1.5, fy + 0.375, oz - 1.0),
        ("bed", (0.3, 0.35, 0.7), 2.0, 0.55, 1.3, ox + 2.6, fy + 0.275, oz - 2.1),
    ]
    buf = bytearray(); views, accs, meshes, nodes, mats = [], [], [], [], []

    def add(data, target):
        while len(buf) % 4: buf.append(0)
        views.append({"buffer": 0, "byteOffset": len(buf), "byteLength": len(data), "target": target})
        buf.extend(data)
        return len(views) - 1

    for i, (name, col, w, h, d, cx, cy, cz) in enumerate(parts):
        pos, nor, idx = _box(w, h, d, cx, cy, cz)
        pb = b"".join(struct.pack("<3f", *p) for p in pos); nb = b"".join(struct.pack("<3f", *p) for p in nor)
        ib = b"".join(struct.pack("<H", k) for k in idx)
        accs.append({"bufferView": add(pb, 34962), "componentType": 5126, "count": len(pos), "type": "VEC3",
                     "min": [min(p[k] for p in pos) for k in range(3)], "max": [max(p[k] for p in pos) for k in range(3)]})
        a_pos = len(accs) - 1
        accs.append({"bufferView": add(nb, 34962), "componentType": 5126, "count": len(nor), "type": "VEC3"}); a_nor = len(accs) - 1
        accs.append({"bufferView": add(ib, 34963), "componentType": 5123, "count": len(idx), "type": "SCALAR"}); a_idx = len(accs) - 1
        mats.append({"name": name, "pbrMetallicRoughness": {"baseColorFactor": [*col, 1], "metallicFactor": 0, "roughnessFactor": 0.9}})
        meshes.append({"name": name, "primitives": [{"attributes": {"POSITION": a_pos, "NORMAL": a_nor}, "indices": a_idx, "material": i}]})
        nodes.append({"name": name, "mesh": i})
    doc = {"asset": {"version": "2.0", "generator": "dorms-test"}, "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}],
           "nodes": nodes, "meshes": meshes, "materials": mats, "accessors": accs, "bufferViews": views, "buffers": [{"byteLength": len(buf)}]}
    js = json.dumps(doc, separators=(",", ":")).encode()
    while len(js) % 4: js += b" "
    while len(buf) % 4: buf.append(0)
    total = 12 + 8 + len(js) + 8 + len(buf)
    return b"glTF" + struct.pack("<II", 2, total) + struct.pack("<I4s", len(js), b"JSON") + js + struct.pack("<I4s", len(buf), b"BIN\0") + bytes(buf)


if __name__ == "__main__":
    open(sys.argv[1], "wb").write(room_glb())
