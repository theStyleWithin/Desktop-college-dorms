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
def portrait(seed, c1, c2, accent, kind):
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
            d.ellipse((cx - 14, 340, cx + 14, 372), fill=(50, 40, 60))
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
class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
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
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        for w in re.findall(r"\S+\s*", text):
            self.wfile.write(("data: " + json.dumps({"choices": [{"delta": {"content": w}}]}) + "\n\n").encode()); self.wfile.flush(); time.sleep(0.01)
        self.wfile.write(b"data: [DONE]\n\n")
threading.Thread(target=HTTPServer(("127.0.0.1", 18998), Fake).serve_forever, daemon=True).start()

env = dict(os.environ, XDG_DATA_HOME=os.path.join(WORK, "data"), XDG_CONFIG_HOME=os.path.join(WORK, "cfg"), XDG_CACHE_HOME=os.path.join(WORK, "cache"),
           GDK_BACKEND="x11", WEBKIT_DISABLE_COMPOSITING_MODE="1", WEBKIT_DISABLE_DMABUF_RENDERER="1")
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
    tmp = os.path.join(WORK, name + ".png"); d.get_screenshot_as_file(tmp)
    im = Image.open(tmp).convert("RGB"); im.save(os.path.join(OUT, name + ".png"), "PNG", optimize=True)
    print("saved", name, im.size, os.path.getsize(os.path.join(OUT, name + ".png")) // 1024, "KB", flush=True)
DESK, PHONE = (1280, 820), (390, 844)

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
    inv("set_favorite", {"id": ids["Mira Okafor"], "favorite": True})
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

    # profiles: the Profile tab, then the welcome screen you see once a profile exists
    inv("create_profile", {"handle": "Alex", "displayName": "Alex", "passcode": "demo-pass"}); reload_ui()
    nav("Settings"); d.execute_script("[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Profile').click()"); time.sleep(0.6)
    snap("desktop-profile", DESK)
    d.set_window_size(*PHONE); time.sleep(0.6)
    d.execute_script("[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Profile').click()"); time.sleep(0.6)
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
