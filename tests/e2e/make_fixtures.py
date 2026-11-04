"""Writes the card/avatar fixtures used by the end-to-end suite.

Cards are written with Pillow's PNG text-chunk support, i.e. an implementation independent of
the Rust code under test, in the shapes real card tools produce (tEXt, zTXt, ccv3, V1, loose JSON).
usage: python3 make_fixtures.py <out-dir>
"""
import base64, json, os, sys
from PIL import Image, ImageDraw
from PIL.PngImagePlugin import PngInfo

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
os.chdir(out)

def art(color, name):
    im = Image.new("RGB", (400, 600), color)
    d = ImageDraw.Draw(im); d.ellipse((120, 120, 280, 280), fill=(255, 255, 255)); d.text((150, 320), name, fill=(255, 255, 255))
    return im

v2 = {"spec": "chara_card_v2", "spec_version": "2.0", "data": {
    "name": "Mira Okafor", "description": "Sleepy RA on the 3rd floor of Maple Hall.", "personality": "warm, tired", "scenario": "2am in the hallway",
    "first_mes": "*yawns* Oh. Hi, {{user}}. You're up late.", "mes_example": "<START>\n{{user}}: hey\n{{char}}: *waves sleepily*",
    "creator_notes": "Test card v2", "system_prompt": "", "post_history_instructions": "", "alternate_greetings": ["Hey there!", "*looks up from her laptop*"],
    "tags": ["dorm", "ra", "cozy"], "creator": "tester", "character_version": "1.0",
    "extensions": {"world": "maple", "depth_prompt": {"prompt": "Mira is exhausted.", "depth": 4, "role": "system"}, "unknown_ext": {"keep": [1, 2, 3]}},
    "character_book": {"name": "Maple Hall", "scan_depth": 4, "token_budget": 300, "recursive_scanning": False, "extensions": {},
        "entries": [{"keys": ["library"], "content": "The library closes at 10pm.", "extensions": {}, "enabled": True, "insertion_order": 10,
                     "case_sensitive": False, "name": "lib", "priority": 1, "id": 0, "comment": "", "selective": False,
                     "secondary_keys": [], "constant": False, "position": "before_char"}]},
    "future_field": {"hello": "world"}}}

info = PngInfo(); info.add_text("chara", base64.b64encode(json.dumps(v2).encode()).decode())      # tEXt, what most tools write
art((90, 60, 150), "Mira").save("mira_v2.png", pnginfo=info)
json.dump(v2, open("mira_v2.json", "w"))

v3 = json.loads(json.dumps(v2)); v3["spec"] = "chara_card_v3"; v3["spec_version"] = "3.0"
v3["data"].update(name="田中 Hiro", nickname="Hiro", group_only_greetings=[], description="日本語の説明 — naïve café ☕")
info = PngInfo(); info.add_text("ccv3", base64.b64encode(json.dumps(v3, ensure_ascii=False).encode()).decode())
art((40, 110, 120), "Hiro").save("hiro_v3.png", pnginfo=info)
json.dump(v3, open("hiro_v3.json", "w"), ensure_ascii=False)

info = PngInfo(); info.add_text("chara", base64.b64encode(json.dumps(v2).encode()).decode(), zip=True)  # zTXt
art((150, 60, 60), "Ztxt").save("ztxt_v2.png", pnginfo=info)

json.dump({"name": "Old Timer", "description": "A V1 card.", "personality": "gruff", "scenario": "porch", "first_mes": "Hmph.",
           "mes_example": "<START>\n{{char}}: Hmph."}, open("v1_flat.json", "w"))
json.dump({"spec": "chara_card_v2", "spec_version": 2, "data": {"name": "Loose", "description": ["line one", "line two"], "tags": "a, b, c",
           "alternate_greetings": "solo greeting", "extensions": None, "first_mes": "hi",
           "character_book": {"entries": {"0": {"key": "cat, dog", "content": "pets", "disable": False, "order": "5", "position": 0}}}}},
          open("loose.json", "w"))
art((20, 20, 20), "Plain").save("plain.png")
frames = [art((200, 100 + i * 30, 80), "G%d" % i) for i in range(4)]
frames[0].save("avatar.gif", save_all=True, append_images=frames[1:], duration=150, loop=0)
print("fixtures written to", out)
