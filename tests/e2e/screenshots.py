"""Renders the README screenshots from the real app, using original demo characters.

Replies come from a tiny fake OpenAI-compatible server so the conversations read nicely and are
repeatable; everything else is the real app. Phone shots are the same UI at phone width (the Android
app shares this frontend).

usage: xvfb-run -a python3 tests/e2e/screenshots.py <app-binary> <work-dir> <out-dir>
"""
import base64, io, json, math, os, random, re, shutil, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

from PIL import Image, ImageDraw, ImageFilter
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.options import ArgOptions
from selenium.webdriver.remote.file_detector import UselessFileDetector

APP, WORK, OUT = [os.path.abspath(a) for a in sys.argv[1:4]]
shutil.rmtree(WORK, ignore_errors=True); os.makedirs(OUT, exist_ok=True)
DATA = os.path.join(WORK, "data", "io.github.thestylewithin.dorms")

# ---------------------------------------------------------------- original demo art (procedural)
def portrait(seed, c1, c2, accent, kind, mood=None):
    rnd = random.Random(seed); W, H = 640, 960
    im = Image.new("RGB", (W, H)); px = im.load()
    for y in range(H):
        t = y / H
        for x in range(W):
            px[x, y] = tuple(int(c1[i] * (1 - t) + c2[i] * t) for i in range(3))
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0)); g = ImageDraw.Draw(glow)
    for _ in range(14):  # soft bokeh lights, like string lights in a dorm window
        r = rnd.randint(30, 90); x, y = rnd.randint(0, W), rnd.randint(0, int(H * .55))
        g.ellipse((x - r, y - r, x + r, y + r), fill=accent + (rnd.randint(40, 90),))
    im = Image.alpha_composite(im.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(18)))
    d = ImageDraw.Draw(im)
    skin = (238, 204, 176) if kind != "owl" else (214, 160, 80)
    body = tuple(max(0, v - 70) for v in c2)
    d.ellipse((60, 560, 580, 1180), fill=body)                       # shoulders
    d.rectangle((270, 470, 370, 610), fill=skin)                     # neck
    if kind == "owl":
        d.ellipse((170, 190, 470, 520), fill=skin)
        for cx in (255, 385):
            d.ellipse((cx - 60, 300, cx + 60, 420), fill=(255, 245, 220)); d.ellipse((cx - 22, 335, cx + 22, 385), fill=(40, 30, 20))
        d.polygon([(320, 395), (295, 440), (345, 440)], fill=(240, 150, 40))
        d.polygon([(190, 215), (230, 150), (255, 225)], fill=skin); d.polygon([(450, 215), (410, 150), (385, 225)], fill=skin)
        d.arc((200, 260, 440, 330), 200, 340, fill=(120, 80, 30), width=6)
    else:
        hair = tuple(max(0, v - 120) for v in accent) if kind == "a" else (40, 32, 52)
        d.ellipse((190, 150, 450, 520), fill=hair if kind == "a" else skin)
        d.ellipse((200, 210, 440, 500), fill=skin)
        d.pieslice((180, 120, 460, 380), 180, 360, fill=hair)         # hair cap
        if kind == "a": d.rectangle((180, 250, 215, 520), fill=hair); d.rectangle((425, 250, 460, 520), fill=hair)
        for cx in (270, 370):
            if mood == "happy": d.arc((cx - 16, 342, cx + 16, 376), 200, 340, fill=(50, 40, 60), width=6)   # eyes closed in a smile
            else: d.ellipse((cx - 14, 340, cx + 14, 372), fill=(50, 40, 60))
        if mood == "happy":
            d.arc((258, 385, 382, 468), 10, 170, fill=(150, 70, 80), width=7)
            for cx in (252, 388): d.ellipse((cx - 22, 392, cx + 22, 420), fill=(255, 150, 150))
        elif mood == "sad":
            d.arc((268, 425, 372, 485), 200, 340, fill=(150, 80, 80), width=6); d.ellipse((246, 380, 262, 412), fill=(150, 200, 255))
            d.arc((250, 318, 292, 338), 200, 340, fill=(60, 50, 70), width=4); d.arc((348, 318, 390, 338), 200, 340, fill=(60, 50, 70), width=4)
        elif mood == "surprised":
            d.ellipse((300, 405, 340, 455), fill=(110, 50, 60))
        else:
            d.arc((275, 400, 365, 450), 20, 160, fill=(150, 80, 80), width=5)
        if kind == "b": d.rounded_rectangle((235, 325, 305, 385), 14, outline=(240, 220, 120), width=6); d.rounded_rectangle((335, 325, 405, 385), 14, outline=(240, 220, 120), width=6); d.line((305, 350, 335, 350), fill=(240, 220, 120), width=6)
    out = io.BytesIO(); im.convert("RGB").save(out, "PNG", optimize=True); return out.getvalue()

CHARS = [
 dict(name="Mira Okafor", tagline="Sleepy RA on the third floor of Maple Hall", tags=["dorm", "cozy", "mentor"], art=(1, (58, 40, 110), (24, 18, 54), (255, 190, 100), "a"),
      description="Mira is the resident advisor on the third floor of Maple Hall. She runs on tea, sticky notes and quiet kindness, and she always knows who is awake at 2am.",
      first="*looks up from a laptop covered in sticky notes* Oh. You're up too? Come in, I've got tea and a very sad plant for company."),
 dict(name="Hiro Tanaka", tagline="Chemistry major who panics early and studies late", tags=["dorm", "student", "chaotic"], art=(2, (24, 92, 104), (10, 36, 54), (130, 230, 220), "b"),
      description="Hiro is Mira's neighbour: a chemistry major with a color-coded flashcard system and a talent for catastrophising before exams.",
      first="Okay, okay, don't judge. I know the exam is at nine. I just needed to see another human being."),
 dict(name="Professor Quill", tagline="An owl who gives office hours at midnight", tags=["campus", "wise", "fantasy"], art=(3, (120, 74, 24), (46, 28, 14), (255, 214, 120), "owl"),
      description="Professor Quill is the campus owl who somehow holds a doctorate in everything. Office hours are whenever someone is brave enough to knock.",
      first="*ruffles feathers over a stack of ungraded essays* Hoo. A visitor. Sit, sit. Mind the tea, it is older than the library."),
 dict(name="Juno Reyes", tagline="Campus radio host with strong opinions about playlists", tags=["music", "campus", "friendly"], art=(4, (126, 40, 96), (44, 16, 48), (255, 140, 170), "a"),
      description="Juno hosts the late-night campus radio show from a closet-sized studio. She can recommend a song for any mood and has never once stayed on topic.",
      first="You're live on 88.1, the only station that plays what you actually need. So. What kind of night is it?"),
]
# canned replies per character (cycled), so the demo conversation reads well
REPLIES = {
 "Mira Okafor": ["*pours a second mug* Sit. Exams are loud, but 2am is quiet. We can be loud together.", "Honestly? Flashcards at this hour are just anxiety with better handwriting. Water, a snack, then one more pass.", "*slides a sticky note across the desk* Look: 'You know more than you think.' I write one for every floor meeting."],
 "Hiro Tanaka": ["I have color-coded cards for every reaction mechanism and I still can't remember what a Grignard does. Help.", "Wait. Did either of you hear that? ...Never mind, it's just the radiator. Third time tonight.", "Okay but if Professor Quill says one more riddle at my exam I am transferring to a different department."],
 "Professor Quill": ["*peers over spectacles* Hoo. A Grignard reagent adds carbon where you least expect it, much like Mondays.", "The secret to examinations: sleep is a study technique. I recommend it to everyone but myself.", "*taps a feather on the desk* Knock three times at my door if you need me. The fourth knock is for emergencies and snacks."],
 "Juno Reyes": ["That's a 'rain on the window, nowhere to be' kind of night. Spinning something slow, for everyone still awake in Maple Hall.", "Dedication to the third floor: you're not alone in there. Next up, a song with absolutely too many strings.", "Request line is open. Lowest bidder is a very good lofi playlist. Highest is whatever Hiro panics to."],
}
CHANNEL = {  # the late-night channel conversation, in speaking order
 "Mira Okafor": ["*pours a mug and slides it across* Exam brain doesn't switch off on command, but tea helps. What's the exam on?"],
 "Hiro Tanaka": ["Organic chemistry. Please say something comforting, I have colour-coded my panic.", "Okay, but if Professor Quill shows up at my exam I am transferring departments."],
 "Professor Quill": ["*peers over spectacles* Hoo. A Grignard reagent adds carbon where you least expect it, much like Mondays. You know more than you fear."],
}
seen_counts = {}
override = {}  # one reply to say next, word for word
class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        data = json.dumps({"data": [{"id": "demo"}]}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        sys_msg = body["messages"][0]["content"]
        m = re.search(r"Write (?:only )?(.+?)'s next reply", sys_msg)
        who = m.group(1) if m else "Mira Okafor"
        grp = "group chat" in sys_msg
        key = ("g", who) if grp else ("d", who)
        i = seen_counts.get(key, 0); seen_counts[key] = i + 1
        pool = CHANNEL.get(who) if grp and who in CHANNEL else REPLIES.get(who, ["Hello!"])
        text = pool[i % len(pool)]
        if override.get("text"): text = override.pop("text")
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        for w in re.findall(r"\S+\s*", text):
            self.wfile.write(("data: " + json.dumps({"choices": [{"delta": {"content": w}}]}) + "\n\n").encode()); self.wfile.flush(); time.sleep(0.01)
        self.wfile.write(b"data: [DONE]\n\n")
threading.Thread(target=HTTPServer(("127.0.0.1", 18998), Fake).serve_forever, daemon=True).start()

env = dict(os.environ, XDG_DATA_HOME=os.path.join(WORK, "data"), XDG_CONFIG_HOME=os.path.join(WORK, "cfg"), XDG_CACHE_HOME=os.path.join(WORK, "cache"),
           GDK_BACKEND="x11", WEBKIT_DISABLE_COMPOSITING_MODE="1", WEBKIT_DISABLE_DMABUF_RENDERER="1", **({} if os.environ.get("STARTERS_SHOT") else {"DORMS_NO_STARTERS": "1"}))
drv = subprocess.Popen(["tauri-driver"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(2)
opts = ArgOptions(); opts.set_capability("browserName", "wry"); opts.set_capability("tauri:options", {"application": APP})
from selenium.webdriver.remote.client_config import ClientConfig
d = webdriver.Remote(command_executor="http://127.0.0.1:4444", options=opts, client_config=ClientConfig(remote_server_addr="http://127.0.0.1:4444", timeout=90))
d.file_detector = UselessFileDetector(); d.set_script_timeout(60)

def inv(cmd, args=None):
    r = d.execute_async_script("const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]||{}).then(v=>done({ok:v})).catch(e=>done({err:String(e)}));", cmd, args)
    if "err" in r: raise RuntimeError(f"{cmd}: {r['err']}")
    return r["ok"]
def reload_ui():
    d.refresh(); time.sleep(2.2)
def nav(label): d.execute_script("[...document.querySelectorAll('nav button')].find(b=>b.textContent.includes(arguments[0])).click()", label); time.sleep(0.8)
def snap(name, size, scroll=0, bottom=False):
    d.set_window_size(*size); time.sleep(0.8)
    # show chats from their first message, unless the shot is about the newest one
    d.execute_script("const m=document.querySelector('.msgs'); if(m) m.scrollTop=arguments[0]?m.scrollHeight:0;", bottom)
    if scroll: d.execute_script("document.querySelector('.main').scrollTop=arguments[0]", scroll)
    d.execute_script("document.querySelectorAll('.toasts').forEach(e=>e.innerHTML='')"); time.sleep(0.3)
    # WebKitWebDriver's own screenshot call can hang on a software-rendered display, so grab the (virtual) screen: the window sits at its top-left corner
    from PIL import ImageGrab
    im = ImageGrab.grab(xdisplay=os.environ["DISPLAY"]).crop((0, 0, size[0], size[1])).convert("RGB"); im.save(os.path.join(OUT, name + ".png"), "PNG", optimize=True)
    print("saved", name, im.size, os.path.getsize(os.path.join(OUT, name + ".png")) // 1024, "KB", flush=True)
DESK, PHONE = (1440, 860), (390, 844)

try:
    time.sleep(3)
    blank = lambda **k: dict(dict(name="", description="", personality="", scenario="", first_mes="", mes_example="", creator_notes="", system_prompt="", post_history_instructions="",
                                  alternate_greetings=[], character_book=None, tags=[], creator="", character_version="", nickname="", group_only_greetings=[], extensions={}), **k)
    ids = {}
    for c in CHARS:
        card = blank(name=c["name"], description=c["description"], first_mes=c["first"], tags=c["tags"], extensions={"dorms": {"tagline": c["tagline"]}})
        ch = inv("save_character", {"character": {"card": card, "trusted": True}})
        b64 = base64.b64encode(portrait(*c["art"])).decode()
        d.execute_async_script("const done=arguments[arguments.length-1];const b=Uint8Array.from(atob(arguments[0]),c=>c.charCodeAt(0));window.__TAURI_INTERNALS__.invoke('set_media', b, {headers:{'x-char-id':arguments[1],'x-file-name':'a.png'}}).then(()=>done(1)).catch(e=>done(String(e)));", b64, ch["id"])
        ids[c["name"]] = ch["id"]
    for who in ["Mira Okafor", "Hiro Tanaka", "Juno Reyes"]: inv("set_favorite", {"id": ids[who], "favorite": True})
    STATUS = {"Mira Okafor": "Kettle's on. Come find me.", "Hiro Tanaka": "Reviewing flashcards. Send snacks.", "Professor Quill": "Office hours: knock twice, then wait.", "Juno Reyes": "On air till 3. Requests open."}
    for who, t in STATUS.items(): inv("set_status", {"characterId": ids[who], "text": t})
    prof = dict(id="demo", name="Demo server", format="openai", base_url="http://127.0.0.1:18998/v1", model="demo", chat_path="/chat/completions", auth="none", auth_header="", headers=[], extra_body="")
    st = inv("get_settings"); st.update(provider="custom:demo", profiles=[prof], user_name="Alex", max_tokens=200); inv("save_settings", {"settings": st})

    def say(chat, text):
        inv("add_user_message", {"chatId": chat, "text": text})
    def reply(chat, who=None):
        inv("generate", {"chatId": chat, "characterId": ids[who] if who else None, "regenerateMessageId": None})
        n = len(inv("list_messages", {"chatId": chat}))
        for _ in range(60):
            time.sleep(0.25)
            if len(inv("list_messages", {"chatId": chat})) > n: break
        time.sleep(0.4)

    dm = inv("create_chat", {"dormId": None, "name": "Mira Okafor", "kind": "dm", "characterIds": [ids["Mira Okafor"]]})
    say(dm["id"], "Hi Mira. I can't sleep and the chem exam is in seven hours."); reply(dm["id"])
    say(dm["id"], "Is it silly that I keep re-reading the same flashcards?"); reply(dm["id"])
    dorm = inv("create_dorm", {"name": "Maple Hall"})
    chan = inv("create_chat", {"dormId": dorm["id"], "name": "late-night", "kind": "channel", "characterIds": [ids["Mira Okafor"], ids["Hiro Tanaka"], ids["Professor Quill"]]})
    inv("create_chat", {"dormId": dorm["id"], "name": "radio-88-1", "kind": "channel", "characterIds": [ids["Juno Reyes"]]})
    inv("create_chat", {"dormId": None, "name": "Professor Quill", "kind": "dm", "characterIds": [ids["Professor Quill"]]})
    say(chan["id"], "Anyone else awake? Exam brain won't switch off.")
    for who in ["Mira Okafor", "Hiro Tanaka", "Professor Quill", "Hiro Tanaka"]:
        reply(chan["id"], who)

    d.execute_script("localStorage.setItem('dorms.members.open','1'); localStorage.setItem('dorms.side.frame', arguments[0])", ids["Juno Reyes"])
    reload_ui()
    snap("desktop-home", DESK)
    nav("Characters"); snap("desktop-library", DESK)
    # editor (top + middle)
    d.execute_script("[...document.querySelectorAll('.ccard h3')].find(x=>x.textContent==='Mira Okafor').click()"); time.sleep(1.2)
    snap("desktop-editor", DESK)
    nav("Dorms")
    d.execute_script("[...document.querySelectorAll('.chatlist .it')].find(b=>b.textContent.includes('late-night')).click()"); time.sleep(1.2)
    snap("desktop-channel", DESK)
    d.execute_script("[...document.querySelectorAll('.chatlist .it')].find(b=>b.textContent.includes('Mira Okafor')).click()"); time.sleep(1.2)
    snap("desktop-chat", DESK)

    # phone layout (same UI at phone width)
    d.set_window_size(*PHONE); time.sleep(1)
    nav("Home"); snap("mobile-home", PHONE)
    nav("Characters"); snap("mobile-library", PHONE)
    nav("Dorms")
    d.execute_script("const b=[...document.querySelectorAll('.chathead button')].find(x=>x.textContent.trim()==='☰'); if(b) b.click();"); time.sleep(0.6)
    d.execute_script("[...document.querySelectorAll('.chatlist .it')].find(b=>b.textContent.includes('Mira Okafor')).click()"); time.sleep(1.2)
    snap("mobile-chat-actions", PHONE, bottom=True)
    nav("Dorms"); d.execute_script("document.querySelector('.chatlist.open')||0"); 
    d.execute_script("const b=[...document.querySelectorAll('.chathead button')].find(x=>x.textContent.trim()==='☰'); if(b) b.click();"); time.sleep(0.6)
    d.execute_script("[...document.querySelectorAll('.chatlist .it')].find(b=>b.textContent.includes('late-night')).click()"); time.sleep(1.2)
    snap("mobile-channel", PHONE)

    # settings: other API + built-in models, then a light theme shot
    other = dict(prof, id="openrouter", name="OpenRouter", base_url="https://openrouter.ai/api/v1", model="meta-llama/llama-3.3-70b-instruct", auth="bearer")
    st = inv("get_settings"); st.update(profiles=[prof, other], provider="custom:openrouter"); inv("save_settings", {"settings": st}); reload_ui()
    nav("Settings"); d.execute_script("[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Models').click()"); time.sleep(0.6)
    snap("mobile-settings", PHONE)
    d.set_window_size(*DESK); time.sleep(0.8)
    snap("desktop-other-api", DESK, scroll=0)
    st = inv("get_settings"); st.update(provider="local", theme="paper"); inv("save_settings", {"settings": st}); reload_ui()
    nav("Characters"); snap("desktop-light-theme", DESK)
    nav("Settings"); d.execute_script("[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Models').click()"); time.sleep(0.6)
    st = inv("get_settings"); st.update(theme="dusk"); inv("save_settings", {"settings": st}); reload_ui()
    nav("Settings"); snap("desktop-models", DESK)

    # ---- what's new: mood pictures, rooms and pathways, the picture frame -------------------------------------
    st = inv("get_settings"); st.update(provider="custom:demo", profiles=[prof], theme="dusk"); inv("save_settings", {"settings": st})
    def upload(cmd, data, headers):
        b64 = base64.b64encode(data).decode()
        r = d.execute_async_script("const done=arguments[arguments.length-1];const b=Uint8Array.from(atob(arguments[0]),c=>c.charCodeAt(0));window.__TAURI_INTERNALS__.invoke(arguments[1], b, {headers:arguments[2]}).then(v=>done({ok:v})).catch(e=>done({err:String(e)}));", b64, cmd, headers)
        if "err" in r: raise RuntimeError(r["err"])
        return r["ok"]
    mira = ids["Mira Okafor"]; mira_art = CHARS[0]["art"]; gal = {}
    for mood in ["happy", "sad", "calm", "surprised"]:
        res = upload("add_gallery_image", portrait(*mira_art, mood if mood != "calm" else None), {"x-char-id": mira, "x-file-name": mood + ".png"}); gal[mood] = res["gallery"][-1]["id"]
    for mood, tags in [("happy", ["happy", "laughing"]), ("sad", ["sad", "crying"]), ("calm", ["neutral"]), ("surprised", ["surprised", "scared"])]:
        inv("set_gallery_moods", {"id": mira, "itemId": gal[mood], "moods": tags})
    inv("set_gallery_mode", {"id": mira, "mode": "mood"})
    reload_ui(); nav("Characters")
    d.execute_script("[...document.querySelectorAll('.ccard h3')].find(x=>x.textContent==='Mira Okafor').click()"); time.sleep(1.2)
    d.execute_script("const e=[...document.querySelectorAll('h1,h2,h3,h4,label,span,b,div')].find(x=>x.children.length===0&&x.textContent.trim().startsWith('Gallery')); if(e) e.scrollIntoView({block:'start'});"); time.sleep(0.6)
    snap("desktop-gallery-editor", DESK)
    nav("Dorms")
    d.execute_script("[...document.querySelectorAll('.chatlist .it')].find(b=>b.textContent.includes('Mira Okafor')).click()"); time.sleep(1.0)
    say(dm["id"], "I think I finally understand Grignard reagents!")
    override["text"] = "*laughs and claps her hands* Haha! That's the best news I've heard all week. You are going to ace it!"
    reply(dm["id"]); reload_ui(); nav("Dorms")
    d.execute_script("[...document.querySelectorAll('.chatlist .it')].find(b=>b.textContent.includes('Mira Okafor')).click()"); time.sleep(1.5)
    snap("desktop-gallery-chat", DESK, bottom=True)

    mk = lambda name, kind, desc, bd, parent=None: inv("create_room", {"room": dict(name=name, kind=kind, description=desc, owner_kind="self", character_id=None, backdrop=bd, parent_id=parent, links=[], id=0, created_at=0)})
    house = mk("Our house", "other", "A narrow blue house with a creaky porch and a very loud radiator.", "preset:lamplight")
    kitchen = mk("Kitchen", "kitchen", "Yellow tiles, a rattling kettle and a plant that has seen things.", "preset:morning", house["id"])
    living = mk("Living room", "living_room", "A sagging sofa, a bookshelf and a rug with a suspicious stain.", "preset:paper", house["id"])
    attic = mk("Attic", "bedroom", "Dusty boxes and one round window. No way out but down.", "preset:night-window", house["id"])
    gate = mk("Garden gate", "garden", "A gate in a mossy wall, humming with crickets.", "preset:garden")
    shop = mk("Corner shop", "other", "Open all night. The owner knows everyone's order.", "preset:neon")
    inv("set_room_links", {"id": kitchen["id"], "links": [gate["id"]]}); inv("set_room_links", {"id": gate["id"], "links": [kitchen["id"], shop["id"]]}); inv("set_room_links", {"id": living["id"], "links": [gate["id"]]})
    pos = {str(house["id"]): {"x": 10, "y": 20}, str(kitchen["id"]): {"x": 340, "y": 20}, str(living["id"]): {"x": 670, "y": 20}, str(attic["id"]): {"x": 10, "y": 290}, str(gate["id"]): {"x": 340, "y": 290}, str(shop["id"]): {"x": 670, "y": 290}}
    d.execute_script("localStorage.setItem('dorms.rooms.map', arguments[0]); localStorage.setItem('dorms.rooms.view','map'); localStorage.setItem('dorms.members.open','0')", json.dumps(pos))
    reload_ui(); nav("Rooms"); time.sleep(0.8)
    snap("desktop-pathways-map", DESK)
    d.execute_script("localStorage.setItem('dorms.members.open','1')")

    home = inv("create_dorm", {"name": "Our house", "roomId": house["id"]})
    walk = inv("create_chat", {"dormId": home["id"], "name": "Coffee at home", "kind": "dm", "characterIds": [mira]})
    say(walk["id"], "Can't sleep. Want to do something?")
    override["text"] = "*stretches and grins* Honestly? Let's go to the kitchen and make some coffee."
    reply(walk["id"])
    inv("move_chat", {"chatId": walk["id"], "roomId": kitchen["id"]})
    say(walk["id"], "Lead the way.")
    override["text"] = "*the kettle rattles as she fills two mugs* Two sugars, right? Don't tell the plant."
    reply(walk["id"]); reload_ui(); nav("Dorms")
    d.execute_script("[...document.querySelectorAll('.chatlist .it')].find(b=>b.textContent.includes('Coffee at home')).click()"); time.sleep(1.5)
    snap("desktop-go-to", DESK, bottom=True)

    nav("Characters"); time.sleep(0.6)
    d.execute_script("document.querySelector('[aria-label=\"Choose who hangs in the picture frame\"]').click()"); time.sleep(0.8)
    snap("desktop-picture-frame", DESK)
    d.execute_script("[...document.querySelectorAll('.modal button')].find(b=>b.textContent.trim()==='Cancel').click()"); time.sleep(0.4)
    snap("desktop-side-bar", (1440, 1340))   # tall enough to show every side bar extra
    d.set_window_size(*DESK); time.sleep(0.5)

    # ---- new in 0.13 ------------------------------------------------------------------------------------------------
    def safe(label, fn):
        try: fn()
        except Exception as ex: print("SKIPPED", label, "->", str(ex)[:200], flush=True)
    def tab(label): d.execute_script("[...document.querySelectorAll('.tab')].find(b=>b.textContent===arguments[0]).click()", label); time.sleep(0.8)
    def click_btn(sel, text=None): d.execute_script("const e=[...document.querySelectorAll(arguments[0])].find(b=>!arguments[1]||b.textContent.includes(arguments[1]));e.click()", sel, text); time.sleep(0.8)
    chars_all = inv("list_characters")

    def decorations():
        st = inv("get_settings"); st["deco"] = dict(st["deco"], plate="bubbletea", bg="boba", wreath="bobacup", tag="KOI", animate=False)
        inv("save_settings", {"settings": st})
        looks = [("sakura", "", "catphones"), ("aurora", "", "lotus"), ("embers", "", "sprout"), ("tide", "", "koi"), ("starfield", "", "pearlring"), ("neongrid", "", "redlantern")]
        for c, (pl, bg, wr) in zip(chars_all, looks): inv("set_char_deco", {"characterId": c["id"], "plate": pl, "bg": bg, "wreath": wr})
        reload_ui(); nav("Settings"); tab("Profiles"); d.execute_script("document.querySelector('[data-testid=fold-deco] summary').click()"); time.sleep(0.8)
        snap("desktop-decorations", (1440, 1100))
    safe("decorations", decorations)

    def world():
        w = inv("create_world", {"name": "Lantern Quarter", "description": "A neon-lit district of tea houses, rooftops and one very crowded house."})
        inv("update_world", {"id": w["id"], "name": "Lantern Quarter", "description": "A neon-lit district of tea houses, rooftops and one very crowded house.", "lore": "# The Lantern Quarter\n\nBuilt along an old canal, the Quarter never quite sleeps. Paper lanterns hang between the rooftops and the corner shop is open all night.\n\n## Who lives here\n- Students who forgot to go home\n- A tea seller who knows everyone's order\n\n## Good to know\nThe attic has one round window and no way out but down.", "lorebooks": []})
        inv("move_rooms_to_world", {"ids": [house["id"], kitchen["id"], living["id"], attic["id"]], "worldId": w["id"]})
        d.execute_script("localStorage.setItem('dorms.rooms.view','cards'); localStorage.removeItem('dorms.rooms.world')")
        reload_ui(); nav("Rooms"); time.sleep(0.8)
        d.execute_script("document.querySelector('[data-testid=world-chip-%d]').click()" % w["id"]); time.sleep(0.8)
        d.execute_script("document.querySelector('[data-testid=world-read]').click()"); time.sleep(1.0)
        snap("desktop-world-overview", (1440, 1000))
        d.execute_script("document.querySelector('.modal button[aria-label=Close]').click()"); time.sleep(0.4)
    safe("world", world)

    pb = {}
    def playbooks():
        tpl = inv("playbook_templates")
        pb["p"] = inv("save_playbook", {"playbook": tpl[0]}); inv("save_playbook", {"playbook": tpl[1]})
        reload_ui(); nav("Playbooks"); time.sleep(0.8)
        snap("desktop-playbooks", (1440, 1000))
        click_btn("[data-pb] button", pb["p"]["name"]); time.sleep(0.8)
        snap("desktop-playbook-editor", (1440, 1100))
    safe("playbooks", playbooks)

    def playbook_panel():
        if "p" not in pb: raise RuntimeError("no playbook")
        inv("set_chat_playbook", {"chatId": walk["id"], "mode": "set", "playbookId": pb["p"]["id"], "scenario": None})
        v = pb["p"]["variables"][0]; hi = (v.get("max") or 10); inv("set_playbook_values", {"chatId": walk["id"], "values": {v["id"]: hi * 0.6}})
        reload_ui(); nav("Dorms")
        d.execute_script("[...document.querySelectorAll('.chatlist .it')].find(b=>b.textContent.includes('Coffee at home')).click()"); time.sleep(1.5)
        d.execute_script("document.querySelector('[data-testid=pb-open]').click()"); time.sleep(1.0)
        snap("desktop-playbook-panel", (1440, 1000))
        d.execute_script("document.querySelector('.modal button[aria-label=Close]').click()"); time.sleep(0.5)
        d.execute_script("document.querySelector('[data-testid=novel-open]').click()"); time.sleep(1.0)
        d.execute_script("const t=document.querySelector('[data-testid=novel-plot]');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,'A slow-burn mystery in the old library, ending on a twist.');t.dispatchEvent(new Event('input',{bubbles:true}))"); time.sleep(0.6)
        snap("desktop-novel", (1440, 1000))
        d.execute_script("document.querySelector('.modal button[aria-label=Close]').click()"); time.sleep(0.4)
    safe("playbook panel and novel", playbook_panel)

    def tokenator():
        reload_ui(); nav("Characters"); time.sleep(0.8)
        d.execute_script("document.querySelector('.ccard h3').click()"); time.sleep(1.5)
        d.execute_script("document.querySelector('[data-testid=tokenator-open]').scrollIntoView({block:'center'})"); time.sleep(0.5)
        snap("desktop-tokenator-button", (1440, 1000))
        d.execute_script("document.querySelector('[data-testid=tokenator-open]').click()"); time.sleep(0.8)
        d.execute_script("const t=document.querySelector('[data-testid=tok-notes]');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,'Shy library student who loves tea and secretly writes poems.');t.dispatchEvent(new Event('input',{bubbles:true}))"); time.sleep(0.5)
        snap("desktop-tokenator", (1440, 1100))
        d.execute_script("document.querySelector('.modal button[aria-label=Close]').click()"); time.sleep(0.4)
    safe("tokenator", tokenator)

    def lists_and_drawer():
        for t in ["Anti-Generic Stereotype Lock (for kink/role safety)", "Bratty Tsundere", "Cheerful Energetic Genki Girl", "Soft redirect", "A very long prompt title that needs room to be read in full"]:
            inv("save_prompt", {"prompt": {"id": "", "title": t, "tag": "", "body": "Example prompt text.", "created_at": 0, "updated_at": 0}})
        book = {"name": "", "description": "", "scan_depth": None, "token_budget": None, "recursive_scanning": None, "extensions": {}, "entries": []}
        books = [inv("save_lorebook", {"lorebook": {"id": "", "name": n, "book": dict(book, name=n), "created_at": 0, "updated_at": 0}}) for n in ["NSFW AI prompt (unlock the model)", "Aether Gazer", "Genshin Impact: Teyvat characters and places", "Honkai Star Rail"]]
        f1 = inv("create_shelf_folder", {"kind": "lorebooks", "name": "AI prompts", "parent": None}); f2 = inv("create_shelf_folder", {"kind": "lorebooks", "name": "canon character lore", "parent": None})
        for b_, f_ in zip(books, [f1, f2, f2, f2]): inv("move_to_shelf_folder", {"kind": "lorebooks", "itemId": b_["id"], "folder": f_["id"]})
        reload_ui(); nav("Lorebooks"); time.sleep(0.8)
        snap("desktop-lorebooks-list", (1440, 900))
        d.execute_script("const r=document.querySelector('.notes-list .resizer');r.focus();for(let i=0;i<8;i++)r.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))"); time.sleep(0.6)
        snap("desktop-lorebooks-wide", (1440, 900))
        d.execute_script("document.querySelector('[data-testid=prompts-toggle]').click()"); time.sleep(0.8)
        d.execute_script("const g=document.querySelector('[data-testid=drawer-pull]');g.focus();for(let i=0;i<6;i++)g.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));const e=document.querySelector('[data-testid=drawer-edge]');for(let i=0;i<4;i++)e.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))"); time.sleep(0.8)
        snap("desktop-prompts-drawer", (1440, 900))
        d.execute_script("document.querySelector('[data-testid=prompts-toggle]').click()"); time.sleep(0.3)
    safe("lists and drawer", lists_and_drawer)

    def settings_tabs():
        reload_ui(); nav("Settings"); tab("Profiles"); snap("desktop-settings-profiles", (1440, 1000))
        tab("Customization"); snap("desktop-settings-customization", (1440, 1000))
        d.execute_script("document.querySelector('[data-testid=fold-emoji] summary').click()"); time.sleep(1.0)
        snap("desktop-settings-customization-emoji", (1440, 1100), scroll=700)
    safe("settings tabs", settings_tabs)

    def tokenator_prompt():
        reload_ui(); nav("Characters"); time.sleep(0.5)
        d.execute_script("document.querySelector('[data-testid=prompts-toggle]').click()"); time.sleep(0.8)
        d.execute_script("document.querySelector('[data-testid=prompt-ask-tokenator]').click()"); time.sleep(0.8)
        d.execute_script("const t=document.querySelector('[data-testid=tokenator-make-notes]');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,'a gentle way to slow the story down when it moves too fast');t.dispatchEvent(new Event('input',{bubbles:true}))"); time.sleep(0.4)
        snap("desktop-tokenator-prompt-ask", (1440, 1000))
        override["text"] = "TITLE: Gentle brakes\nLABEL: Pace\nTEXT:\n(OOC: Let's slow this scene down a little. Describe one small moment in detail before moving on, {{char}}, and let {{user}} react before anything big happens.)"
        d.execute_script("document.querySelector('[data-testid=tokenator-make-go]').click()"); time.sleep(3.0)
        snap("desktop-tokenator-prompt-draft", (1440, 1000))
        d.execute_script("document.querySelector('.modal button[aria-label=Close]').click()"); time.sleep(0.4)
        d.execute_script("document.querySelector('[data-testid=prompts-toggle]').click()"); time.sleep(0.3)
    safe("tokenator prompt", tokenator_prompt)

    def tokenator_lorebook():
        reload_ui(); nav("Lorebooks"); time.sleep(0.8)
        d.execute_script("document.querySelector('.notes-list .note-item').click()"); time.sleep(0.8)
        d.execute_script("document.querySelector('.notes-main [data-testid=tokenator-make-lorebook]').click()"); time.sleep(0.5)
        d.execute_script("const t=document.querySelector('[data-testid=tokenator-make-notes]');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,'a moonlit canal district with a gossiping tea seller and a library that closes at dusk');t.dispatchEvent(new Event('input',{bubbles:true}))"); time.sleep(0.4)
        override["text"] = "ENTRY: The Moonlit Canal\nKEYS: canal, moonlight, lanterns\nTEXT: A slow canal lined with paper lanterns that glow after dark. Small boats sell warm snacks along its banks.\n\nENTRY: The Tea Seller\nKEYS: tea seller, tea, gossip\nTEXT: An old seller who remembers everyone's usual order and shares neighbourhood gossip for free.\n\nENTRY: The Old Library\nKEYS: library, old library, closing time\nTEXT: A crumbling hall of shelves that locks its doors at dusk, whatever the weather."
        d.execute_script("document.querySelector('[data-testid=tokenator-make-go]').click()"); time.sleep(3.0)
        d.execute_script("document.querySelector('[data-testid=tokenator-helper-lorebook]').scrollIntoView({block:'start'})"); time.sleep(0.4)
        snap("desktop-tokenator-lorebook-draft", (1440, 1100))
    safe("tokenator lorebook", tokenator_lorebook)

    def folders():
        bk = lambda n: {"name": n, "description": "", "scan_depth": None, "token_budget": None, "recursive_scanning": None, "extensions": {}, "entries": [{"keys": ["lantern"], "content": "Paper lanterns hang between the rooftops.", "extensions": {}, "enabled": True, "insertion_order": 0, "case_sensitive": None, "name": "Lanterns", "priority": None, "id": 0, "comment": "", "selective": False, "secondary_keys": [], "constant": False, "position": "before_char"}]}
        made = {n: inv("save_lorebook", {"lorebook": {"id": "", "name": n, "book": bk(n), "created_at": 0, "updated_at": 0}}) for n in ["Lantern Quarter", "Corner shop regulars", "House rules", "Tea menu", "Old canal history", "Rooftop secrets"]}
        f1 = inv("create_shelf_folder", {"kind": "lorebooks", "name": "World building", "parent": None}); f2 = inv("create_shelf_folder", {"kind": "lorebooks", "name": "Places", "parent": f1["id"]}); f3 = inv("create_shelf_folder", {"kind": "lorebooks", "name": "People", "parent": f1["id"]})
        for n, f in [("Lantern Quarter", f2), ("Old canal history", f2), ("Rooftop secrets", f2), ("Corner shop regulars", f3), ("Tea menu", f3)]: inv("move_to_shelf_folder", {"kind": "lorebooks", "itemId": made[n]["id"], "folder": f["id"]})
        reload_ui(); nav("Lorebooks"); time.sleep(1.0)
        snap("desktop-folders", (1440, 900))
    safe("folders", folders)

    def profile_menu():
        reload_ui(); nav("Characters"); time.sleep(0.6)
        d.execute_script("const e=document.querySelector('[data-testid=me-row]');const r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+30,clientY:r.top+8}))"); time.sleep(0.6)
        snap("desktop-profile-menu", DESK)
        d.execute_script("document.querySelector('[data-testid=pm-quick]').click()"); time.sleep(0.8)
        snap("desktop-quick-settings", DESK)
        d.execute_script("document.querySelector('.modal button[aria-label=Close]').click()"); time.sleep(0.4)
    safe("profile menu", profile_menu)
    d.set_window_size(*DESK); time.sleep(0.5)

    # profiles: the Profile tab, then the welcome screen you see once a profile exists
    inv("create_profile", {"handle": "Alex", "displayName": "Alex", "passcode": "demo-pass"}); reload_ui()
    nav("Settings"); d.execute_script("[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Profiles').click()"); time.sleep(0.6)
    snap("desktop-profile", DESK)
    d.set_window_size(*PHONE); time.sleep(0.6)
    d.execute_script("[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Profiles').click()"); time.sleep(0.6)
    snap("mobile-profile", PHONE)
    inv("sign_out"); reload_ui()
    snap("mobile-welcome", PHONE)
    snap("desktop-welcome", DESK)
finally:
    try: d.quit()
    except Exception: pass
    drv.terminate()
    subprocess.run(["pkill", "-x", "WebKitWebDriver"], check=False)
    subprocess.run(["pkill", "-f", "^/[^ ]*(dorms-engine|desktop-college-dorms)"], check=False)
