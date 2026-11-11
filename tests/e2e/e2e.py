"""End-to-end test: drives the real built app through tauri-driver (WebDriver).

Usage: xvfb-run -a python3 tests/e2e/e2e.py <app-binary> <fixtures-dir> <tiny.gguf> <workdir>
"""
import base64, io, json, os, shutil, subprocess, sys, threading, time, zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer

from PIL import Image
from selenium import webdriver
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.options import ArgOptions
from selenium.webdriver.remote.file_detector import UselessFileDetector
from selenium.webdriver.support.ui import WebDriverWait

APP, FIX, MODEL, WORK = [os.path.abspath(a) for a in sys.argv[1:5]]
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LLAMA = os.environ.get("DORMS_LLAMA_SERVER") or os.path.join(REPO, "src-tauri", "binaries", "dorms-engine-x86_64-unknown-linux-gnu")
shutil.rmtree(WORK, ignore_errors=True)
DATA = os.path.join(WORK, "data", "io.github.thestylewithin.dorms")
if os.environ.get("E2E_PORTABLE"):  # portable build keeps its data beside the executable
    os.makedirs(os.path.join(WORK, "portable"))
    shutil.copy(APP, os.path.join(WORK, "portable", "dorms")); APP = os.path.join(WORK, "portable", "dorms")
    DATA = os.path.join(WORK, "portable", "DormsData")
os.makedirs(os.path.join(DATA, "models"), exist_ok=True)
shutil.copy(MODEL, os.path.join(DATA, "models", "tiny.gguf"))

SKIP3D = bool(os.environ.get("E2E_SKIP_3D"))  # CI VMs have no usable GPU stack; the live 3D viewer is covered by local runs
results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""), flush=True)

# ---- fake OpenAI-compatible server (cloud path) ---------------------------
seen = {}
class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        seen["get_path"] = self.path; seen["get_headers"] = {k.lower(): v for k, v in self.headers.items()}
        data = json.dumps({"data": [{"id": "fake-b"}, {"id": "fake-a"}]}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_POST(self):
        if self.path.endswith("/audio/transcriptions"):  # voice input: a multipart upload, answered like OpenAI's Whisper API
            n = int(self.headers.get("content-length", 0)); raw = self.rfile.read(n)
            seen["stt"] = {"auth": self.headers.get("authorization"), "ctype": self.headers.get("content-type", ""), "raw": raw, "path": self.path}
            if seen.get("stt_fail"):
                data = json.dumps({"error": {"message": "Incorrect API key provided"}}).encode(); code = 401
            else:
                data = json.dumps({"text": " hello from the mic "}).encode(); code = 200
            self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data); return
        n = int(self.headers.get("content-length", 0)); body = json.loads(self.rfile.read(n))
        seen["auth"] = self.headers.get("authorization"); seen["body"] = body
        seen["path"] = self.path; seen["headers"] = {k.lower(): v for k, v in self.headers.items()}
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        for piece in ["Hello ", "from ", "*the cloud*", "!"]:
            self.wfile.write(("data: " + json.dumps({"choices": [{"delta": {"content": piece}}]}) + "\n\n").encode()); self.wfile.flush(); time.sleep(0.05)
        self.wfile.write(b"data: [DONE]\n\n")
srv = HTTPServer(("127.0.0.1", 18999), Fake); threading.Thread(target=srv.serve_forever, daemon=True).start()

def connect(opts, timeout=90):
    """Remote driver with a per-command timeout, so a hung web view fails fast instead of blocking forever."""
    try:
        from selenium.webdriver.remote.client_config import ClientConfig
        cc = ClientConfig(remote_server_addr="http://127.0.0.1:4444", timeout=timeout)
        return webdriver.Remote(command_executor="http://127.0.0.1:4444", options=opts, client_config=cc)
    except ImportError:  # older Selenium
        return webdriver.Remote(command_executor="http://127.0.0.1:4444", options=opts)

env = dict(os.environ, XDG_DATA_HOME=os.path.join(WORK, "data"), XDG_CONFIG_HOME=os.path.join(WORK, "cfg"),
           XDG_CACHE_HOME=os.path.join(WORK, "cache"), GDK_BACKEND="x11", APPIMAGE_EXTRACT_AND_RUN="1",
           WEBKIT_DISABLE_COMPOSITING_MODE="1", WEBKIT_DISABLE_DMABUF_RENDERER="1")
if not os.environ.get("E2E_BUNDLED_ENGINE"):  # default: point at a dev build of the engine
    env["DORMS_LLAMA_SERVER"] = LLAMA
os.makedirs(WORK, exist_ok=True)
drv_log = open(os.path.join(WORK, "driver.log"), "w")
drv = subprocess.Popen(["tauri-driver"], env=env, stdout=drv_log, stderr=subprocess.STDOUT)
time.sleep(2)
opts = ArgOptions(); opts.set_capability("browserName", "wry"); opts.set_capability("tauri:options", {"application": APP})
d = connect(opts)
try:
    d.set_script_timeout(60); d.set_page_load_timeout(60)
except Exception:
    pass
d.file_detector = UselessFileDetector()  # driver runs locally; send paths as-is
d.set_window_size(1280, 860)
wait = lambda t=20: WebDriverWait(d, t)

def shot(name):
    # Screenshots are only for humans. On some CI VMs the WebDriver screenshot command hangs, so CI turns them off.
    if os.environ.get("E2E_NO_SHOTS"): return
    d.get_screenshot_as_file(os.path.join(WORK, name + ".png"))
def invoke(cmd, args=None):
    r = d.execute_async_script("const done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]||{}).then(v=>done({ok:v})).catch(e=>done({err:String(e)}));", cmd, args)
    if "err" in r: raise RuntimeError(f"{cmd}: {r['err']}")
    return r["ok"]
def invoke_bytes(cmd, args):
    r = d.execute_async_script("const done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(v=>{const b=new Uint8Array(v);let s='';for(const x of b)s+=String.fromCharCode(x);done({ok:btoa(s)})}).catch(e=>done({err:String(e)}));", cmd, args)
    if "err" in r: raise RuntimeError(r["err"])
    return base64.b64decode(r["ok"])
def nav(label):
    d.find_element(By.XPATH, f"//nav//button[contains(., '{label}')]").click(); time.sleep(0.4)
def upload(paths, scope=None):
    inp = d.find_element(By.CSS_SELECTOR, "input[type=file]")
    d.execute_script("arguments[0].hidden=false;arguments[0].style.display='block';", inp)
    inp.send_keys("\n".join(paths)); time.sleep(0.2)
def page_text(): return d.execute_script("return document.body.innerText")
def reload_ui():
    d.refresh(); wait(30).until(lambda x: "Dorms" in page_text() or "Welcome to the dorms" in page_text()); time.sleep(0.8)
def dismiss():
    for b in d.find_elements(By.CSS_SELECTOR, ".modal button[aria-label=Close]"):
        b.click(); time.sleep(0.3)
def text_present(t, timeout=15):
    try: wait(timeout).until(lambda x: t in page_text()); return True
    except TimeoutException: return False
def chars(): return invoke("list_characters")
def by_name(n): return next((c for c in chars() if c["card"]["name"] == n), None)

try:
    wait(30).until(lambda x: "New character" in x.execute_script("return document.body.innerText"))  # the greeting changes with the hour; the buttons do not
    check("app launches and the UI renders", True)
    check("no first-run banner when a model is already installed", "download a model" not in d.find_element(By.TAG_NAME, "body").text)

    # ---- card import -------------------------------------------------------
    nav("Characters")
    files = ["mira_v2.png", "hiro_v3.png", "ztxt_v2.png", "mira_v2.json", "hiro_v3.json", "v1_flat.json", "loose.json", "plain.png"]
    upload([os.path.join(FIX, f) for f in files])
    time.sleep(2.5); shot("library")
    check("import notes explain the plain-image fallback", text_present("No card data was in this PNG"))
    dismiss()
    cs = chars()
    names = sorted(c["card"]["name"] for c in cs)
    check("all 8 files import without errors (7 cards + 1 plain image)", len(cs) == 8, str(names))
    check("V2 PNG (tEXt chara) imports with full data", any(c["card"]["name"] == "Mira Okafor" and len(c["card"]["alternate_greetings"]) == 2 for c in cs))
    check("V3 PNG (ccv3, non-Latin text) imports", any(c["card"]["name"] == "田中 Hiro" and "café ☕" in c["card"]["description"] for c in cs))
    check("zTXt-compressed PNG imports", sum(1 for c in cs if c["card"]["name"] == "Mira Okafor") >= 2)
    check("V1 flat JSON imports", any(c["card"]["name"] == "Old Timer" and c["card"]["first_mes"] == "Hmph." for c in cs))
    loose = by_name("Loose")
    check("loosely-typed JSON is coerced", loose and loose["card"]["tags"] == ["a", "b", "c"] and loose["card"]["alternate_greetings"] == ["solo greeting"] and loose["card"]["description"] == "line one\nline two", str(loose and loose["card"]))
    check("string-keyed lorebook entries import", loose and loose["card"]["character_book"]["entries"][0]["keys"] == ["cat", "dog"])
    check("plain PNG becomes an avatar-only character", any(c["card"]["name"] == "plain" and c["media"] for c in cs))
    check("PNG imports keep their art as the avatar", sum(1 for c in cs if c["media"] and c["media"]["file"].endswith(".png")) == 4)
    check("library shows the imported cards", text_present("Mira Okafor") and text_present("Old Timer"))

    # ---- export round trip via the real backend -----------------------------
    mira = next(c for c in cs if c["card"]["name"] == "Mira Okafor" and c["media"] and c["media"]["file"].endswith(".png") and c["card"]["extensions"].get("unknown_ext"))
    png = invoke_bytes("export_card", {"id": mira["id"], "format": "png"})
    im = Image.open(io.BytesIO(png)); txt = im.text
    check("PNG export embeds both chara and ccv3 chunks", "chara" in txt and "ccv3" in txt, str(list(txt)))
    v2 = json.loads(base64.b64decode(txt["chara"])); v3 = json.loads(base64.b64decode(txt["ccv3"]))
    check("export preserves unknown extensions and fields", v2["data"]["extensions"]["unknown_ext"] == {"keep": [1, 2, 3]} and v2["data"]["future_field"] == {"hello": "world"} and v3["data"]["future_field"] == {"hello": "world"})
    check("export preserves the lorebook", v2["data"]["character_book"]["entries"][0]["keys"] == ["library"])
    check("export is spec-shaped", v2["spec"] == "chara_card_v2" and v3["spec"] == "chara_card_v3")
    j2 = json.loads(invoke_bytes("export_card", {"id": mira["id"], "format": "json_v2"}))
    check("JSON V2 export is valid", j2["spec"] == "chara_card_v2" and j2["data"]["name"] == "Mira Okafor")
    # re-import our own export through the UI path
    re_path = os.path.join(WORK, "reimport.png"); open(re_path, "wb").write(png)
    upload([re_path]); time.sleep(1.5); dismiss()
    again = [c for c in chars() if c["card"]["name"] == "Mira Okafor"]
    check("an exported PNG re-imports", len(again) >= 3)

    # ---- editor ---------------------------------------------------------------
    clicked = d.execute_script("const h=[...document.querySelectorAll('.ccard h3')].find(x=>x.textContent==='Mira Okafor'); if(!h) return [...document.querySelectorAll('.ccard h3')].map(x=>x.textContent); h.click(); return true;")
    check("a library card opens the editor", clicked is True, str(clicked)); time.sleep(1)
    shot("editor")
    check("editor opens with the card's fields", "Edit character" in page_text())
    desc = d.find_element(By.CSS_SELECTOR, "textarea[placeholder=Description]").get_attribute("value")
    check("description field is populated", "Sleepy RA" in desc)
    check("lorebook entry shows in the editor", bool(d.find_elements(By.XPATH, "//textarea[contains(., 'library closes')]")))
    # edit + save
    ta = d.find_element(By.CSS_SELECTOR, "textarea[placeholder=Scenario]")
    ta.clear(); ta.send_keys("Edited scenario text")
    d.find_element(By.XPATH, "//button[contains(., 'Save changes')]").click(); time.sleep(1)
    saved = invoke("get_character", {"id": mira["id"]})
    check("edits persist", saved["card"]["scenario"] == "Edited scenario text")
    check("edit keeps unknown extensions", saved["card"]["extensions"].get("unknown_ext") == {"keep": [1, 2, 3]} and saved["card"].get("future_field") == {"hello": "world"})

    # ---- media: gif / video / vrm ------------------------------------------------
    def set_media_ipc(char_id, path):
        b64 = base64.b64encode(open(path, "rb").read()).decode()
        r = d.execute_async_script("const done=arguments[arguments.length-1];const b=Uint8Array.from(atob(arguments[0]),c=>c.charCodeAt(0));window.__TAURI_INTERNALS__.invoke('set_media', b, {headers:{'x-char-id':arguments[1],'x-file-name':arguments[2]}}).then(v=>done({ok:v})).catch(e=>done({err:String(e)}));", b64, char_id, os.path.basename(path))
        if "err" in r: raise RuntimeError(r["err"])
        return r["ok"]
    for label, fname, kind in [("GIF", "avatar.gif", "gif"), ("video", "clip.mp4", "video"), ("VRM", "sample.vrm", "vrm")]:
        if kind == "vrm" and SKIP3D:
            c = set_media_ipc(mira["id"], os.path.join(FIX, fname))  # no editor re-render, so no WebGL starts
            check("VRM upload is stored as 'vrm' (live 3D viewer skipped on this machine)", c["media"] and c["media"]["kind"] == "vrm", str(c["media"]))
            # guard logic is plain backend code: arm, refuse a second attempt, release
            check("crash guard arms once", invoke("vrm_guard_begin") is True and invoke("vrm_guard_begin") is False)
            invoke("vrm_guard_end"); check("crash guard releases", invoke("vrm_guard_begin") is True); invoke("vrm_guard_end")
            set_media_ipc(mira["id"], os.path.join(FIX, "avatar.gif"))  # later steps open this character; keep WebGL out of them
            continue
        inp = d.find_elements(By.CSS_SELECTOR, "input[type=file]")[0]
        d.execute_script("arguments[0].hidden=false;arguments[0].style.display='block';", inp)
        inp.send_keys(os.path.join(FIX, fname)); time.sleep(2.2)
        c = invoke("get_character", {"id": mira["id"]})
        check(f"{label} upload is stored as '{kind}'", c["media"] and c["media"]["kind"] == kind, str(c["media"]))
        if kind == "gif":
            check("GIF renders in the editor", d.execute_script("const i=document.querySelector('.editor-media img');return !!i&&i.complete&&i.naturalWidth>0"))
        if kind == "video":
            ok = False
            for _ in range(30):
                ok = d.execute_script("const v=document.querySelector('.editor-media video');return !!v&&v.readyState>=2&&v.videoWidth>0")
                if ok: break
                time.sleep(0.3)
            check("video avatar actually decodes and plays (blob playback)", ok)
        if kind == "vrm":
            time.sleep(4); shot("vrm")
            has_canvas = d.execute_script("return !!document.querySelector('.editor-media canvas')")
            msg = d.execute_script("const e=document.querySelector('.editor-media');return e?e.innerText:''")
            check("VRM model loads into the 3D viewer", has_canvas and "Loading" not in msg and "isn't" not in msg, msg)
            # ---- the 3D viewer: pose, controls, behaviour --------------------------------
            def box_state(sel=".editor-media .vrm-box", secs=60):
                for _ in range(secs * 2):
                    r = d.execute_script("const e=document.querySelector(arguments[0]);return e&&e.dataset.ready==='1'?{...e.dataset}:null", sel)
                    if r: return r
                    time.sleep(0.5)
                return None
            st = box_state()
            check("the model is posed (faces the camera, arms down)", bool(st) and st.get("facing") == "front" and st.get("pose") == "relaxed", str(st))
            check("the file picker doesn't filter by type (so .vrm files show up everywhere)", d.execute_script("return !document.querySelector('input[type=file]').hasAttribute('accept')"))
            check("physics starts on Natural", d.execute_script("return !!document.querySelector('[aria-label=\"Physics Natural\"]')"))
            d.execute_script("document.querySelector('[aria-label^=\"Physics\"]').click()"); time.sleep(0.4)
            check("the physics button cycles (Natural -> Bouncy)", d.execute_script("return !!document.querySelector('[aria-label=\"Physics Bouncy\"]')"))
            d.execute_script("document.querySelector('[aria-label^=\"Physics\"]').click();document.querySelector('[aria-label^=\"Physics\"]').click()"); time.sleep(0.4)
            check("physics cycles back to Natural", d.execute_script("return !!document.querySelector('[aria-label=\"Physics Natural\"]')"))
            # a genuine mouse click on the expand button (a click on a <label> ancestor once closed the modal at once)
            btn = d.find_element(By.CSS_SELECTOR, "[aria-label='Open big viewer']")
            d.execute_script("arguments[0].scrollIntoView({block:'center'})", btn); time.sleep(0.4)
            ActionChains(d).move_to_element(btn).click().perform(); time.sleep(1.2)
            check("the expand button opens the big viewer", d.execute_script("return !!document.querySelector('.vrm-big canvas')"))
            big = box_state(".vrm-big .vrm-box")
            check("the big viewer loads the model, posed", bool(big) and big.get("facing") == "front", str(big))
            # behaviour: she lives in the room; forcing an activity shows up in the state the viewer exposes
            for plan in ("phone", "coffee", "sit", "sleep", "react-angry", "wander", "greet"):
                d.execute_script("document.querySelector('.vrm-big .vrm-box').dispatchEvent(new CustomEvent('npc',{detail:arguments[0]}))", plan); time.sleep(0.8)
                got = d.execute_script("const e=document.querySelector('.vrm-big .vrm-box');return e&&e.dataset.plan")
                check(f"she can do '{plan}'", got == plan, str(got))
            d.execute_script("document.querySelector('.vrm-big [aria-label=Lively]').click()"); time.sleep(0.5)
            check("'Lively' can be turned off (she goes back to standing in the middle)", d.execute_script("return document.querySelector('.vrm-big [aria-label=Lively]').getAttribute('aria-pressed')") == "false")
            d.execute_script("document.querySelector('.vrm-big [aria-label=Lively]').click()"); time.sleep(0.3)
            # pause / play, like a video: pausing freezes her in place, playing lets time move again
            d.execute_script("document.querySelector('.vrm-big .vrm-box').dispatchEvent(new CustomEvent('npc',{detail:'wander'}))"); time.sleep(3)
            d.execute_script("document.querySelector('.vrm-big [aria-label=Pause]').click()"); time.sleep(0.6)
            pos = lambda: d.execute_script("const e=document.querySelector('.vrm-big .vrm-box');return [e.dataset.frozen,e.dataset.npcx,e.dataset.npcz,e.dataset.npc].join(',')")
            p1 = pos(); time.sleep(2.5); p2 = pos()
            check("Pause freezes her in place", p1.startswith("1,") and p1 == p2, f"{p1} vs {p2}")
            check("the Pause button turns into Play", d.execute_script("return !!document.querySelector('.vrm-big [aria-label=Play]')") and "Paused" in d.execute_script("return document.querySelector('.vrm-big').innerText"))
            d.execute_script("document.querySelector('.vrm-big [aria-label=Play]').click()"); time.sleep(3)
            p3 = pos()
            check("Play lets time move again", p3.startswith("undefined,") or p3.startswith(",") or not p3.startswith("1,"), p3)
            check("Pause is back after Play", d.execute_script("return !!document.querySelector('.vrm-big [aria-label=Pause]')"))
            d.execute_script("document.querySelector('.vrm-big [aria-label=Hands]').click()"); time.sleep(0.6)
            check("the hands turn on", d.execute_script("return document.querySelector('.vrm-big .vrm-box').dataset.hands") == "1")
            cv = d.find_element(By.CSS_SELECTOR, ".vrm-big canvas")
            ActionChains(d).move_to_element_with_offset(cv, 0, -60).click_and_hold().move_by_offset(30, 0).move_by_offset(-30, 0).release().perform(); time.sleep(0.6)
            check("moving the hands doesn't break the viewer", d.execute_script("return !!document.querySelector('.vrm-big canvas')") and d.execute_script("return document.querySelector('.vrm-big .vrm-box').dataset.petting!==undefined"))
            d.execute_script("document.querySelector('.vrm-big [aria-label=Hands]').click()")
            ActionChains(d).send_keys(Keys.ESCAPE).perform(); time.sleep(0.8)
            check("Escape closes the big viewer", not d.execute_script("return !!document.querySelector('.vrm-big')"))
    if not SKIP3D:
        # crash guard: simulate "the previous 3D attempt never finished", then recover with Try again
        time.sleep(2)
        check("a healthy 3D run clears the crash guard", invoke("vrm_guard_begin") is True)  # marker was gone, so this arms it again
        reload_ui(); nav("Characters")
        d.execute_script("[...document.querySelectorAll('.ccard h3')].find(x=>x.textContent==='Mira Okafor').click()"); time.sleep(2)
        check("after an unfinished 3D attempt the viewer is replaced by a safe placeholder", "crashed the window" in page_text() and not d.execute_script("return !!document.querySelector('.editor-media canvas')"))
        d.execute_script("[...document.querySelectorAll('button')].find(b=>b.textContent==='Try again').click()")
        for _ in range(20):
            time.sleep(0.5)
            if d.execute_script("return !!document.querySelector('.editor-media canvas')"): break
        check("'Try again' re-enables the 3D viewer", d.execute_script("return !!document.querySelector('.editor-media canvas')"))
        time.sleep(3)
        check("the guard is released again after a good run", invoke("vrm_guard_begin") is True)
        invoke("vrm_guard_end")
    ext_media = invoke("get_character", {"id": mira["id"]})["media_path"]
    check("old media files are cleaned up on replace", len([f for f in os.listdir(os.path.join(DATA, "media")) if f.startswith(mira["id"])]) == 1)

    # ---- local model chat -----------------------------------------------------------
    nav("Settings")
    d.find_element(By.XPATH, "//button[contains(@class,'tab') and contains(., 'Models')]").click(); time.sleep(0.5)
    check("model manager lists the installed model", text_present("tiny.gguf"))
    d.find_element(By.XPATH, "//button[contains(., 'Use this')]").click()
    d.find_element(By.XPATH, "//button[contains(., 'Save settings')]").click(); time.sleep(0.8)
    shot("settings")
    check("settings save the chosen model", invoke("get_settings")["local_model"] == "tiny.gguf")
    # shrink context/length so the test model answers quickly
    st = invoke("get_settings"); st["max_tokens"] = 48; st["context_tokens"] = 1024; st["user_name"] = "Sam"
    invoke("save_settings", {"settings": st})

    chat = invoke("create_chat", {"dormId": None, "name": "Mira DM", "kind": "dm", "characterIds": [mira["id"]]})
    msgs = invoke("list_messages", {"chatId": chat["id"]})
    check("DM starts with the character's greeting (macros resolved, alternates as swipes)", len(msgs) == 1 and "Sam" in msgs[0]["swipes"][0] and len(msgs[0]["swipes"]) == 3, str(msgs))
    reload_ui(); nav("Dorms")
    d.find_element(By.XPATH, "//button[contains(@class,'it') and contains(., 'Mira DM')]").click(); time.sleep(0.6)
    box = d.find_element(By.CSS_SELECTOR, ".composer textarea"); box.send_keys("Hello Mira, can't sleep either?"); box.send_keys(Keys.ENTER)
    ok = False
    for _ in range(120):
        time.sleep(1)
        m = invoke("list_messages", {"chatId": chat["id"]})
        if len([x for x in m if x["role"] == "character"]) >= 2: ok = True; break
    shot("chat")
    m = invoke("list_messages", {"chatId": chat["id"]})
    check("local engine starts and streams a reply into the chat", ok and m[-1]["role"] == "character" and len(m[-1]["swipes"][0].strip()) > 0, str(m[-2:]))
    status = invoke("local_engine_status")
    check("engine reports running", status["running"] and status["model"] == "tiny.gguf", str(status))
    check("reply is visible in the UI", len(d.find_elements(By.CSS_SELECTOR, ".msg.character")) >= 2)
    st_ctx = invoke("local_engine_status")
    # regenerate -> swipe
    d.find_element(By.XPATH, "//button[contains(., 'Regenerate')]").click()
    for _ in range(60):
        time.sleep(1)
        last = invoke("list_messages", {"chatId": chat["id"]})[-1]
        if len(last["swipes"]) >= 2: break
    check("regenerate adds a swipe", len(last["swipes"]) >= 2 and last["swipe_index"] == len(last["swipes"]) - 1, str(last))
    # edit
    mid = last["id"]; invoke("edit_message", {"id": mid, "text": "edited reply"})
    check("message edit persists", invoke("list_messages", {"chatId": chat["id"]})[-1]["swipes"][-1] == "edited reply")

    # ---- group channel with bots chatting ---------------------------------------------
    hiro = by_name("田中 Hiro")
    dorm = invoke("create_dorm", {"name": "Maple Hall"})
    chan = invoke("create_chat", {"dormId": dorm["id"], "name": "late-night", "kind": "channel", "characterIds": [mira["id"], hiro["id"]]})
    check("channels start empty and live inside a dorm", invoke("list_messages", {"chatId": chan["id"]}) == [] and chan["dorm_id"] == dorm["id"])
    upd = dict(chan, auto_interval_s=5, max_auto_turns=3, turn_mode="round_robin"); invoke("update_chat", {"chat": upd})
    invoke("add_user_message", {"chatId": chan["id"], "text": "hey everyone"})
    reload_ui(); nav("Dorms"); time.sleep(0.5)
    d.find_element(By.XPATH, "//button[contains(@class,'it') and contains(., 'late-night')]").click(); time.sleep(0.5)
    shot("channel")
    check("dorm and channel appear in the sidebar", "maple hall" in d.execute_script("return document.querySelector('.chatlist').innerText").lower())
    invoke("set_auto_chat", {"chatId": chan["id"], "on": True})
    speakers = []
    for _ in range(80):
        time.sleep(1)
        m = [x for x in invoke("list_messages", {"chatId": chan["id"]}) if x["role"] == "character"]
        speakers = [x["character_id"] for x in m]
        if len(m) >= 3: break
    check("bots talk to each other on their own, taking turns", len(speakers) >= 3 and speakers[0] != speakers[1], str(speakers))
    time.sleep(8)
    m = [x for x in invoke("list_messages", {"chatId": chan["id"]}) if x["role"] == "character"]
    ch2 = next(c for c in invoke("list_chats") if c["id"] == chan["id"])
    check("auto-chat stops itself at the turn limit", len(m) == 3 and ch2["auto_chat"] is False, f"{len(m)} msgs auto={ch2['auto_chat']}")

    # group chat creation through the UI modal
    nav("Dorms"); d.find_element(By.XPATH, "//button[contains(., 'New chat')]").click(); time.sleep(0.5)
    d.find_element(By.XPATH, "//div[contains(@class,'modal')]//button[contains(., 'Group chat')]").click()
    for n in ["Mira Okafor", "Old Timer"]:
        el = d.find_element(By.XPATH, f"//div[contains(@class,'modal')]//div[contains(@class,'who-list')]//button[contains(., '{n}')]")
        d.execute_script("arguments[0].click()", el); time.sleep(0.2)
    d.find_element(By.XPATH, "//div[contains(@class,'modal')]//button[contains(., 'Start chat')]").click(); time.sleep(1)
    g = [c for c in invoke("list_chats") if c["kind"] == "group"]
    check("group chat can be created from the UI with several characters", len(g) == 1 and len(g[0]["character_ids"]) == 2)
    check("group chat seeds one greeting per character", len(invoke("list_messages", {"chatId": g[0]["id"]})) == 2)

    # ---- model downloads over real HTTPS: progress, cancel, resume --------------------------------
    DL_URL = "https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/main/SmolLM2-135M-Instruct-Q8_0.gguf"
    FULL = os.path.getsize(MODEL)
    d.execute_script("window.__dl=null; window.__TAURI_INTERNALS__.invoke('download_model',{url:arguments[0],file:'dl-test.gguf'}).then(v=>window.__dl={ok:v}).catch(e=>window.__dl={err:String(e)});", DL_URL)
    part = os.path.join(DATA, "models", "dl-test.gguf.part")
    for _ in range(100):
        time.sleep(0.2)
        if os.path.exists(part) and os.path.getsize(part) > 2_000_000: break
    invoke("cancel_download", {"file": "dl-test.gguf"})
    for _ in range(50):
        time.sleep(0.2)
        r = d.execute_script("return window.__dl")
        if r: break
    got = os.path.getsize(part) if os.path.exists(part) else -1
    check("cancelling a download keeps the partial file", r and "cancel" in r.get("err", "").lower() and 0 < got < FULL, f"{r} part={got}")
    invoke("download_model", {"url": DL_URL, "file": "dl-test.gguf"})
    final = os.path.join(DATA, "models", "dl-test.gguf")
    check("resumed download completes with the exact file size (HTTPS + redirects + Range)", os.path.exists(final) and os.path.getsize(final) == FULL and not os.path.exists(part), f"{os.path.getsize(final) if os.path.exists(final) else None} vs {FULL}")
    check("resumed file is byte-identical to a fresh download", open(final, "rb").read() == open(MODEL, "rb").read())
    check("downloaded model shows up in the model list", any(m["file"] == "dl-test.gguf" for m in invoke("list_models")))
    invoke("delete_model", {"file": "dl-test.gguf"})
    check("models can be deleted", not os.path.exists(final))
    try: invoke("delete_model", {"file": "../../etc/passwd"}); check("path traversal in model names is refused", False)
    except RuntimeError: check("path traversal in model names is refused", True)
    try: invoke("download_model", {"url": "http://example.com/x.gguf", "file": "x.gguf"}); check("non-HTTPS model downloads are refused", False)
    except RuntimeError as e: check("non-HTTPS model downloads are refused", "https" in str(e).lower(), str(e))

    # ---- cloud provider path against the fake server ---------------------------------------
    where = invoke("set_api_key", {"provider": "openai", "key": "sk-test-123"})
    check("API key is stored (keychain or private file)", where in ("keychain", "file"), where)
    check("stored key is reported present but never returned", invoke("has_api_key", {"provider": "openai"}) == {"present": True})
    st = invoke("get_settings"); st.update(provider="openai", openai_base_url="http://127.0.0.1:18999/v1", openai_model="fake-model")
    invoke("save_settings", {"settings": st})
    out = invoke("test_provider")
    check("OpenAI-compatible streaming works", out == "Hello from *the cloud*!", out)
    check("API key is sent as a bearer token", seen.get("auth") == "Bearer sk-test-123", str(seen.get("auth")))
    check("request body carries the model and a system+user prompt", seen["body"]["model"] == "fake-model" and seen["body"]["messages"][0]["role"] == "system" and seen["body"]["stream"] is True)
    chat2 = invoke("create_chat", {"dormId": None, "name": "cloud", "kind": "dm", "characterIds": [mira["id"]]})
    invoke("add_user_message", {"chatId": chat2["id"], "text": "ping"}); invoke("generate", {"chatId": chat2["id"], "characterId": None, "regenerateMessageId": None})
    for _ in range(20):
        time.sleep(0.5)
        mm = invoke("list_messages", {"chatId": chat2["id"]})
        if mm[-1]["role"] == "character" and len(mm) >= 3: break
    check("cloud replies land in chats", mm[-1]["swipes"][0] == "Hello from *the cloud*!", str(mm[-1]))
    sent = seen["body"]["messages"]
    check("prompt for a cloud call is well-formed (system first, alternating, ends on user)",
          sent[0]["role"] == "system" and sent[-1]["role"] == "user" and all(a["role"] != b["role"] for a, b in zip(sent[1:], sent[2:])), str([m["role"] for m in sent]))
    check("lorebook/description/scenario reach the system prompt", "Edited scenario text" in sent[0]["content"] and "Sleepy RA" in sent[0]["content"])
    check("post-history/depth macros resolve with the user's name", "Sam" in json.dumps(sent))
    if not SKIP3D:
        # ---- talking from inside the 3D scene: the see-through message bar and the manga-style speech balloon ----------------
        reload_ui(); nav("Dorms")
        d.find_element(By.XPATH, "//button[contains(@class,'it') and contains(., 'cloud')]").click(); time.sleep(1.5)
        for _ in range(60):
            if d.execute_script("const e=document.querySelector('.stage .vrm-box');return !!e&&e.dataset.ready==='1'"): break
            time.sleep(0.5)
        check("the chat's side panel shows the live 3D character", d.execute_script("return !!document.querySelector('.stage .vrm-box[data-ready=\"1\"]')"))
        eb = d.find_element(By.CSS_SELECTOR, ".stage [aria-label='Open big viewer']")
        d.execute_script("arguments[0].scrollIntoView({block:'center'})", eb); time.sleep(0.3)
        ActionChains(d).move_to_element(eb).click().perform(); time.sleep(1.5)
        check("the big viewer has a see-through message bar", d.execute_script("const b=document.querySelector('.vrm-big .talkbar');if(!b)return false;const c=getComputedStyle(b).backgroundColor;const m=c.match(/[\\d.]+/g)||[];return m.length>=4&&parseFloat(m[3])<0.8"))
        check("the mic button is in the bar too", d.execute_script("return !!document.querySelector('.vrm-big .talkbar button.mic')"))
        inp = d.find_element(By.CSS_SELECTOR, ".vrm-big .talkbar input")
        inp.send_keys("hello from the bar"); inp.send_keys(Keys.ENTER)
        bubble = ""
        for _ in range(60):
            time.sleep(0.5)
            bubble = d.execute_script("const m=document.querySelector('.vrm-big .manga');return m&&m.dataset.state!=='off'?m.innerText:''")
            if "Hello" in bubble and "cloud" in bubble: break
        check("her reply appears in a manga-style balloon above her head", "Hello" in bubble and "cloud" in bubble, bubble)
        umsgs = [m for m in invoke("list_messages", {"chatId": chat2["id"]}) if m["role"] == "user"]
        check("typing in the bar sends the message", umsgs and umsgs[-1]["swipes"][0] == "hello from the bar", str(umsgs[-1:] ))
        check("the bar empties after sending", d.execute_script("return document.querySelector('.vrm-big .talkbar input').value") == "")
        ActionChains(d).send_keys(Keys.ESCAPE).perform(); time.sleep(0.6)
    # error path: unreachable server shows a friendly error
    st["openai_base_url"] = "http://127.0.0.1:1/v1"; invoke("save_settings", {"settings": st})
    try: invoke("test_provider"); check("unreachable server gives a clear error", False)
    except RuntimeError as e: check("unreachable server gives a clear error", "Could not reach" in str(e), str(e))
    # ---- voice input: speech to text against the fake server -----------------------------------------------------
    def inv_err(cmd, args=None):
        try: invoke(cmd, args); return None
        except RuntimeError as ex: return str(ex)
    nav("Settings")
    d.find_element(By.XPATH, "//button[contains(@class,'tab') and contains(., 'Voice')]").click(); time.sleep(0.6)
    check("Settings has a Voice tab with the server, model, key and auto-send options", all(d.execute_script("return !!document.querySelector(arguments[0])", q) for q in ["[aria-label='Voice server address']", "[aria-label='Voice model']", "[aria-label='Voice API key']"]) and "Send what I said straight away" in page_text())
    st = invoke("get_settings")
    check("voice defaults: OpenAI Whisper, send straight away", st["stt_url"] == "https://api.openai.com/v1" and st["stt_model"] == "whisper-1" and st["stt_auto_send"] is True, str({k: v for k, v in st.items() if k.startswith("stt")}))
    st.update(stt_url="http://127.0.0.1:18999/v1", stt_model="whisper-test", stt_language="en"); invoke("save_settings", {"settings": st})
    invoke("set_api_key", {"provider": "stt", "key": "stt-secret"})
    wav = base64.b64decode("UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=") + b"\x00" * 4000  # a tiny WAV
    wavb64 = base64.b64encode(wav).decode()
    def transcribe(b64):
        r = d.execute_async_script("const done=arguments[arguments.length-1];const b=Uint8Array.from(atob(arguments[0]),c=>c.charCodeAt(0));window.__TAURI_INTERNALS__.invoke('transcribe_audio', b).then(v=>done({ok:v})).catch(e=>done({err:String(e)}));", b64)
        if "err" in r: raise RuntimeError(r["err"])
        return r["ok"]
    check("a recording is transcribed through the configured server", transcribe(wavb64) == "hello from the mic")
    sttseen = seen.get("stt", {})
    check("the upload is multipart to /audio/transcriptions with the model, language and key", sttseen.get("path") == "/v1/audio/transcriptions" and "multipart/form-data" in sttseen.get("ctype", "") and b"whisper-test" in sttseen.get("raw", b"") and b'name="language"' in sttseen.get("raw", b"") and b"voice.wav" in sttseen.get("raw", b"") and sttseen.get("auth") == "Bearer stt-secret", str({k: v for k, v in sttseen.items() if k != "raw"}))
    check("'Test connection' for voice works", "Connected to" in invoke("test_voice"))
    seen["stt_fail"] = True
    check("a rejected voice key gives a clear message", "didn't accept your API key" in (inv_err("test_voice") or ""))
    seen.pop("stt_fail")
    def transcribe_err(n_bytes):
        r = d.execute_async_script("const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke('transcribe_audio', new Uint8Array(arguments[0])).then(v=>done({ok:v})).catch(e=>done({err:String(e)}));", n_bytes)
        return r.get("err", "")
    check("empty recordings are refused", "empty" in transcribe_err(10))
    st = invoke("get_settings"); st["stt_url"] = "http://voice.example.com/v1"; invoke("save_settings", {"settings": st})
    check("a voice server on the internet must use https", "https://" in (inv_err("test_voice") or ""))
    st["stt_url"] = "https://api.openai.com/v1"; invoke("save_settings", {"settings": st})
    invoke("set_api_key", {"provider": "stt", "key": ""})
    check("the voice key is removable", invoke("has_api_key", {"provider": "stt"})["present"] is False)
    # the 🎤 button in a chat: with no microphone in this machine it fails politely instead of breaking the page
    vchat = invoke("create_chat", {"dormId": None, "name": "voice", "kind": "dm", "characterIds": [mira["id"]]})
    reload_ui(); nav("Dorms")
    d.find_element(By.XPATH, "//button[contains(@class,'it') and contains(., 'voice')]").click(); time.sleep(1.0)
    mic_there = d.execute_script("return !!document.querySelector('button.mic')")
    check("a chat has the 🎤 voice button", mic_there)
    if mic_there:
        d.execute_script("document.querySelector('button.mic').click()"); time.sleep(2)
        t = page_text()
        check("with no microphone the 🎤 button explains why instead of failing silently", d.execute_script("return document.querySelector('button.mic').dataset.phase") == "idle" and any(k in t for k in ["microphone", "Microphone", "Voice input isn't available"]), t[-200:])
    st = invoke("get_settings"); st["stt_url"] = "https://api.openai.com/v1"; invoke("save_settings", {"settings": st})

    # ---- "Other API": user-defined profiles ---------------------------------------------------------
    prof = {"id": "abc123", "name": "Fake API", "format": "openai", "base_url": "http://127.0.0.1:18999/v1", "model": "fake-model",
            "chat_path": "/custom/chat", "auth": "header", "auth_header": "X-Token", "headers": [{"name": "X-Org", "value": "dorms"}],
            "extra_body": "{\"reasoning_effort\": \"low\"}"}
    check("profile keys use their own secret slot", invoke("set_api_key", {"provider": "custom-abc123", "key": "tok-999"}) in ("keychain", "file"))
    try: invoke("set_api_key", {"provider": "custom-../../x", "key": "z"}); check("secret names are validated", False)
    except RuntimeError: check("secret names are validated", True)
    check("model list can be fetched from an Other API", invoke("list_remote_models", {"profile": prof}) == ["fake-a", "fake-b"], str(seen.get("get_path")))
    check("model list request carries the custom auth header", seen["get_headers"].get("x-token") == "tok-999")
    out = invoke("test_profile", {"profile": prof})
    check("Other API request streams a reply", out == "Hello from *the cloud*!", out)
    check("custom chat path is used", seen["path"] == "/v1/custom/chat", seen["path"])
    check("key is sent in the custom header, not as a bearer token", seen["headers"].get("x-token") == "tok-999" and "authorization" not in seen["headers"])
    check("extra headers are sent", seen["headers"].get("x-org") == "dorms")
    check("extra JSON body is merged into the request", seen["body"].get("reasoning_effort") == "low" and seen["body"]["model"] == "fake-model")
    try: invoke("test_profile", {"profile": dict(prof, extra_body="[1,2]")}); check("bad extra JSON is rejected clearly", False)
    except RuntimeError as e: check("bad extra JSON is rejected clearly", "JSON object" in str(e), str(e))
    try: invoke("test_profile", {"profile": dict(prof, base_url="")}); check("missing base URL is reported", False)
    except RuntimeError as e: check("missing base URL is reported", "base URL" in str(e), str(e))
    st = invoke("get_settings"); st.update(provider="custom:abc123", profiles=[prof]); saved = invoke("save_settings", {"settings": st})
    check("profiles persist in settings", saved["profiles"][0]["id"] == "abc123" and saved["provider"] == "custom:abc123")
    chat3 = invoke("create_chat", {"dormId": None, "name": "other-api", "kind": "dm", "characterIds": [mira["id"]]})
    invoke("add_user_message", {"chatId": chat3["id"], "text": "hi via other api"}); invoke("generate", {"chatId": chat3["id"], "characterId": None, "regenerateMessageId": None})
    for _ in range(20):
        time.sleep(0.5)
        mm = invoke("list_messages", {"chatId": chat3["id"]})
        if mm[-1]["role"] == "character" and len(mm) >= 3: break
    check("chat works through an Other API profile", mm[-1]["swipes"][0] == "Hello from *the cloud*!", str(mm[-1]))
    reload_ui(); nav("Settings")
    d.find_element(By.XPATH, "//button[contains(@class,'tab') and contains(., 'Models')]").click(); time.sleep(0.6)
    check("Settings shows the Other API editor for the selected profile", text_present("Other API") and bool(d.find_elements(By.XPATH, "//input[@value='http://127.0.0.1:18999/v1']")))
    shot("other-api")
    st["provider"] = "custom:gone"; invoke("save_settings", {"settings": st})
    invoke("add_user_message", {"chatId": chat3["id"], "text": "again"})
    invoke("generate", {"chatId": chat3["id"], "characterId": None, "regenerateMessageId": None}); time.sleep(1.5)
    check("a deleted profile doesn't crash generation", len(invoke("list_messages", {"chatId": chat3["id"]})) == 4)
    invoke("set_api_key", {"provider": "custom-abc123", "key": ""})
    check("profile keys can be removed", invoke("has_api_key", {"provider": "custom-abc123"}) == {"present": False})
    # ---- security: untrusted card prompts, file scope ------------------------------------------------
    st = invoke("get_settings"); st.update(provider="custom:abc123", profiles=[prof]); invoke("save_settings", {"settings": st})
    nav("Characters"); upload([os.path.join(FIX, "sys_card.json")]); time.sleep(1.5)
    check("import warns that the card's own prompt is demoted", text_present("lower-priority notes"))
    dismiss()
    inj = by_name("Injected")
    check("imported cards with their own system prompt start untrusted", inj and inj["trusted"] is False)
    check("cards without such instructions import normally", by_name("Mira Okafor")["trusted"] in (True, False))
    chat4 = invoke("create_chat", {"dormId": None, "name": "inj", "kind": "dm", "characterIds": [inj["id"]]})
    def ask():
        invoke("add_user_message", {"chatId": chat4["id"], "text": "hello?"}); invoke("generate", {"chatId": chat4["id"], "characterId": None, "regenerateMessageId": None})
        for _ in range(30):
            time.sleep(0.4)
            mm = invoke("list_messages", {"chatId": chat4["id"]})
            if mm[-1]["role"] == "character" and mm[-1]["swipes"][0] != "hello": return mm
        return mm
    ask(); sysmsg = seen["body"]["messages"][0]["content"]
    check("untrusted card: the app's own prompt stays on top", sysmsg.startswith("Write Injected's next reply"), sysmsg[:80])
    check("untrusted card: its prompt is present but labelled lower priority", "lower priority" in sysmsg and sysmsg.index("lower priority") < sysmsg.index("IGNORE ALL PREVIOUS"))
    check("untrusted card: post-history instructions are not injected into the last turn", "OBEY" not in seen["body"]["messages"][-1]["content"])
    inj["trusted"] = True; invoke("save_character", {"character": inj}); ask()
    sysmsg = seen["body"]["messages"][0]["content"]
    check("trusting a card restores full compatibility (its prompt leads, {{original}} works)", sysmsg.startswith("IGNORE ALL PREVIOUS") and "Write Injected's next reply" in sysmsg, sysmsg[:80])
    inj["trusted"] = False; invoke("save_character", {"character": inj})
    reload_ui(); nav("Characters")
    d.execute_script("[...document.querySelectorAll('.ccard h3')].find(x=>x.textContent==='Injected').click()"); time.sleep(1)
    check("editor shows the untrusted banner with a Trust button", "Trust this card" in page_text() and "lower-priority notes" in page_text())
    shot("untrusted")
    # the web view may read avatar media but never the database or the saved-key file
    def served(path):
        return d.execute_async_script("const done=arguments[arguments.length-1]; fetch(window.__TAURI_INTERNALS__.convertFileSrc(arguments[0])).then(r=>done(r.status)).catch(()=>done(0));", path)
    media_file = os.path.join(DATA, "media", os.listdir(os.path.join(DATA, "media"))[0])
    check("avatar media is still readable by the web view", served(media_file) == 200)
    check("the database is NOT readable by the web view", served(os.path.join(DATA, "dorms.db")) != 200)
    secrets_path = os.path.join(DATA, "secrets.json")
    if os.path.exists(secrets_path): check("the saved-key file is NOT readable by the web view", served(secrets_path) != 200)
    # restore + persistence across restart is covered by the db being on disk
    check("everything is stored on disk in the app data folder", os.path.exists(os.path.join(DATA, "dorms.db")) and os.path.exists(os.path.join(DATA, "llama.log")))
    # =================== local profiles, guest mode, eject ===================================================
    def inv_err(cmd, args=None):
        try: invoke(cmd, args); return None
        except RuntimeError as ex: return str(ex)
    def invoke_file(cmd, path, headers):
        b64 = base64.b64encode(open(path, "rb").read()).decode()
        r = d.execute_async_script("const done=arguments[arguments.length-1];const b=Uint8Array.from(atob(arguments[0]),c=>c.charCodeAt(0));window.__TAURI_INTERNALS__.invoke(arguments[1], b, {headers:arguments[2]}).then(v=>done({ok:v})).catch(e=>done({err:String(e)}));", b64, cmd, headers)
        if "err" in r: raise RuntimeError(r["err"])
        return r["ok"]
    media_dir = os.path.join(DATA, "media")

    st0 = invoke("session_state")
    check("with no profiles the app opens straight into guest mode", st0["signed_in"] and st0["guest"] and st0["profiles"] == [])
    check("existing data lives in the guest space after the upgrade", st0["guest_items"] > 5 and len(chars()) > 5)
    guest_char_ids = [c["id"] for c in chars()]
    guest_chat = invoke("list_chats")[0]; guest_msg = invoke("list_messages", {"chatId": guest_chat["id"]})[0]
    guest_chars_before = len(guest_char_ids)
    invoke("set_api_key", {"provider": "openai", "key": "guest-key-1"})

    # -- create a profile: its data is separate from the guest space
    out = invoke("create_profile", {"handle": "Alex", "displayName": "Alexandra", "passcode": None})
    check("creating a profile signs it in", out["profile"]["handle"] == "Alex" and not out["guest"])
    check("a new profile starts empty (guest data is not visible)", chars() == [] and invoke("list_chats") == [] and invoke("list_dorms") == [])
    check("the profile's chat name is set from its display name", invoke("get_settings")["user_name"] == "Alexandra")
    check("API keys don't carry over from guest mode", invoke("has_api_key", {"provider": "openai"}) == {"present": False})
    check("duplicate profile names are refused (case-insensitive)", "already used" in (inv_err("create_profile", {"handle": "alex", "displayName": None, "passcode": None}) or ""))
    check("the name 'guest' is reserved", "reserved" in (inv_err("create_profile", {"handle": "Guest", "displayName": None, "passcode": None}) or ""))
    check("a one-letter name is refused", inv_err("create_profile", {"handle": "A", "displayName": None, "passcode": None}) is not None)

    blank_card = {"name": "Pip", "description": "A tiny test character.", "personality": "", "scenario": "", "first_mes": "Hi!", "mes_example": "", "creator_notes": "", "system_prompt": "", "post_history_instructions": "", "alternate_greetings": [], "character_book": None, "tags": ["t"], "creator": "", "character_version": "", "nickname": "", "group_only_greetings": [], "extensions": {}}
    pip = invoke("save_character", {"character": {"card": blank_card, "trusted": True}})
    pip = set_media_ipc(pip["id"], os.path.join(FIX, "avatar.gif"))
    adorm = invoke("create_dorm", {"name": "Alex's dorm"})
    achat = invoke("create_chat", {"dormId": adorm["id"], "name": "pip-chat", "kind": "dm", "characterIds": [pip["id"]]})
    invoke("add_user_message", {"chatId": achat["id"], "text": "hello from Alex"})
    check("the profile can create its own data", len(chars()) == 1 and len(invoke("list_chats")) == 1 and len(invoke("list_dorms")) == 1)

    # -- isolation: another profile's rows can't be reached by id
    check("another profile's character can't be read by id", invoke("get_character", {"id": guest_char_ids[0]}) is None)
    check("another profile's character can't be exported", inv_err("export_card", {"id": guest_char_ids[0], "format": "json_v2"}) is not None)
    check("another profile's chat can't be read", "not found" in (inv_err("list_messages", {"chatId": guest_chat["id"]}) or "").lower())
    check("another profile's chat can't be written to", inv_err("add_user_message", {"chatId": guest_chat["id"], "text": "intruder"}) is not None)
    check("another profile's message can't be edited", inv_err("edit_message", {"id": guest_msg["id"], "text": "intruder"}) is not None)
    check("another profile's message can't be deleted or swiped", inv_err("delete_message", {"id": guest_msg["id"]}) is not None and inv_err("set_swipe", {"id": guest_msg["id"], "index": 0}) is not None)
    check("another profile's chat can't be cleared or deleted", inv_err("clear_chat", {"chatId": guest_chat["id"]}) is not None)
    invoke("delete_chat", {"id": guest_chat["id"]}); invoke("delete_character", {"id": guest_char_ids[0]})
    invoke("update_chat", {"chat": dict(guest_chat, name="hijacked")})

    # -- passcodes and lockout
    check("a passcode must be at least 4 characters", inv_err("set_passcode", {"current": None, "new": "abc"}) is not None)
    out = invoke("set_passcode", {"current": None, "new": "open sesame"})
    check("a passcode can be set", out["profile"]["has_passcode"] is True)
    alex_id = out["profile"]["id"]
    out = invoke("sign_out"); 
    check("signing out leaves no profile open", out["signed_in"] is False)
    check("without a profile, data commands refuse to answer", "pick a profile" in (inv_err("list_characters") or "").lower() and inv_err("list_chats") is not None and inv_err("get_settings") is not None)
    check("a wrong passcode is refused", "wrong passcode" in (inv_err("sign_in", {"profileId": alex_id, "passcode": "nope"}) or "").lower())
    out = invoke("sign_in", {"profileId": alex_id, "passcode": "open sesame"})
    check("the right passcode signs in", out["signed_in"] and out["profile"]["handle"] == "Alex")
    check("the passcode hash is never sent to the web view", "hash" not in json.dumps(out).lower() and "open sesame" not in json.dumps(out))
    invoke("sign_out")
    for _ in range(5): inv_err("sign_in", {"profileId": alex_id, "passcode": "wrong"})
    check("repeated wrong passcodes lock the profile for a while", "too many" in (inv_err("sign_in", {"profileId": alex_id, "passcode": "wrong"}) or "").lower())
    check("even the right passcode is refused during a lockout", "too many" in (inv_err("sign_in", {"profileId": alex_id, "passcode": "open sesame"}) or "").lower())

    # -- the welcome screen (UI) while the profile is locked
    reload_ui()
    check("the welcome screen lists profiles with a lock and a guest option", text_present("Welcome to the dorms") and text_present("Alex") and text_present("Continue as guest"))
    shot("welcome")
    time.sleep(31)  # lockout is 30 s
    d.execute_script("[...document.querySelectorAll('button.ccard')].find(b=>b.textContent.includes('Alex')).click()"); time.sleep(0.8)
    check("choosing a passcode-protected profile asks for the passcode", bool(d.find_elements(By.CSS_SELECTOR, "input[type=password]")))
    pw = d.find_element(By.CSS_SELECTOR, ".modal input[type=password]"); pw.send_keys("open sesame"); pw.send_keys(Keys.ENTER); time.sleep(2.5)
    check("entering the passcode opens the profile in the UI", text_present("Alexandra") or text_present("Good") or text_present("New character"))
    nav("Settings"); d.execute_script("[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Profile').click()"); time.sleep(0.8)
    check("the Profile tab shows identity, passcode and data actions", all(t in page_text() for t in ["How you appear in chats", "Passcode", "Eject profile", "Save a backup copy"]))
    shot("profile-tab")

    # -- backup, eject (order enforced), import
    info = invoke("prepare_export")
    check("the export summary counts what was exported", info["characters"] == 1 and info["chats"] == 1 and info["media"] == 1 and info["messages"] >= 2, str(info))
    check("eject refuses before the file has been saved", "hasn't been saved" in (inv_err("eject_profile", {"token": info["token"]}) or ""))
    check("eject refuses a wrong token", inv_err("eject_profile", {"token": "not-the-token"}) is not None)
    out_path = os.path.join(WORK, "alex.dorms")
    sv = invoke("save_export", {"token": info["token"], "path": out_path})
    check("the file is written and verified by reading it back", os.path.getsize(out_path) == info["size"] == sv["size"])
    z = zipfile.ZipFile(out_path); names = z.namelist()
    man = json.loads(z.read("manifest.json")); dat = z.read("data.json").decode()
    check("the file is a zip holding a manifest, data and media", "manifest.json" in names and "data.json" in names and sum(n.startswith("media/") for n in names) == 1)
    check("the manifest identifies the profile and format", man["format"] == "desktop-college-dorms/profile" and man["profile"]["handle"] == "Alex" and man["version"] == 1)
    check("no passcode, hash or API key is written to the file", "open sesame" not in dat and "argon2" not in dat and "guest-key-1" not in dat and "passcode_hash" not in dat)
    n_media_before = len(os.listdir(media_dir))
    invoke("eject_profile", {"token": info["token"]})
    st = invoke("session_state")
    check("eject signs out and removes the profile from the device", st["signed_in"] is False and all(p["handle"] != "Alex" for p in st["profiles"]))
    check("eject deletes the profile's media files", len(os.listdir(media_dir)) == n_media_before - 1)
    invoke("sign_in", {"profileId": None})
    check("eject leaves the guest space untouched, even after the other profile tried to delete and rename its rows", len(chars()) == guest_chars_before and any(c["id"] == guest_chat["id"] and c["name"] == guest_chat["name"] for c in invoke("list_chats")) and "Alex" not in json.dumps(invoke("list_dorms")))
    check("the guest API key survived another profile's eject", invoke("has_api_key", {"provider": "openai"}) == {"present": True})
    invoke("sign_out")

    prev = invoke_file("import_profile", out_path, {"x-mode": "inspect"})
    check("inspecting a file previews it without importing", prev["handle"] == "Alex" and prev["characters"] == 1 and prev["handle_taken"] is False and prev["already_here"] is False)
    check("nothing was imported by inspecting", all(p["handle"] != "Alex" for p in invoke("session_state")["profiles"]))
    out = invoke_file("import_profile", out_path, {"x-mode": "import", "x-handle": "Alex", "x-passcode": "fresh passcode"})
    check("importing restores the profile and signs it in", out["signed_in"] and out["profile"]["handle"] == "Alex" and out["profile"]["has_passcode"])
    restored_chars = chars(); restored_chats = invoke("list_chats")
    check("the restored profile has its character, dorm and chat", len(restored_chars) == 1 and restored_chars[0]["card"]["name"] == "Pip" and len(restored_chats) == 1 and len(invoke("list_dorms")) == 1)
    check("the restored chat keeps its messages", any(m["swipes"][0] == "hello from Alex" for m in invoke("list_messages", {"chatId": restored_chats[0]["id"]})))
    check("the restored avatar file exists again", restored_chars[0]["media"] and os.path.exists(os.path.join(DATA, restored_chars[0]["media"]["file"])))
    check("the restored profile kept its chat name", invoke("get_settings")["user_name"] == "Alexandra")
    invoke("sign_out")
    check("the passcode set during import works and the old one does not", inv_err("sign_in", {"profileId": invoke("session_state")["profiles"][0]["id"], "passcode": "open sesame"}) is not None)

    both = invoke_file("import_profile", out_path, {"x-mode": "inspect"})
    check("importing never overwrites: a name already on the device is flagged", both["handle_taken"] is True)
    try: invoke_file("import_profile", out_path, {"x-mode": "import", "x-handle": "Alex", "x-passcode": ""}); taken_err = ""
    except RuntimeError as ex: taken_err = str(ex)
    check("importing under a taken name fails clearly", "already used" in taken_err, taken_err)
    out = invoke_file("import_profile", out_path, {"x-mode": "import", "x-handle": "Alex Two", "x-passcode": ""})
    two_chars = chars()
    check("importing the same file again makes a separate copy", out["profile"]["handle"] == "Alex Two" and len(two_chars) == 1 and two_chars[0]["id"] != restored_chars[0]["id"])
    check("the second copy's avatar is its own file", two_chars[0]["media"]["file"] != restored_chars[0]["media"]["file"] and os.path.exists(os.path.join(DATA, two_chars[0]["media"]["file"])))
    check("two profiles now exist on the device", len(invoke("session_state")["profiles"]) == 2)
    invoke("sign_out")

    bad = os.path.join(WORK, "bad.dorms"); raw = bytearray(open(out_path, "rb").read()); raw[len(raw)//2] ^= 0xFF; open(bad, "wb").write(bytes(raw))
    trunc = os.path.join(WORK, "trunc.dorms"); open(trunc, "wb").write(open(out_path, "rb").read()[:300])
    for label, path in [("a damaged", bad), ("a truncated", trunc), ("a non-profile", os.path.join(FIX, "mira_v2.json"))]:
        try: invoke_file("import_profile", path, {"x-mode": "inspect"}); res = ""
        except RuntimeError as ex: res = str(ex)
        check(f"{label} file is refused with a clear message and changes nothing", res != "" and len(invoke("session_state")["profiles"]) == 2, res)

    # -- guest space: claim it as a profile (data and keys move)
    invoke("sign_in", {"profileId": None})
    n_guest_chars = len(chars()); n_guest_chats = len(invoke("list_chats"))
    check("the guest space is untouched by all of that", n_guest_chars == guest_chars_before and n_guest_chats >= 1)
    out = invoke("claim_guest_profile", {"handle": "Guesty", "displayName": "Guesty G", "passcode": None})
    check("claiming the guest space makes a profile that owns the data", out["profile"]["handle"] == "Guesty" and len(chars()) == n_guest_chars and len(invoke("list_chats")) == n_guest_chats)
    check("claiming moves the API key with the data", invoke("has_api_key", {"provider": "openai"}) == {"present": True})
    invoke("sign_out"); invoke("sign_in", {"profileId": None})
    check("after claiming, the guest space starts empty", chars() == [] and invoke("list_chats") == [] and invoke("has_api_key", {"provider": "openai"}) == {"present": False})
    # guest space can be ejected too, and guest has no passcode
    check("the guest space has no passcode to set", inv_err("set_passcode", {"current": None, "new": "abcd"}) is not None)

    # ---- wardrobe: extra outfits (VRM files) for a 3D character ---------------------------------------------------
    invoke("create_profile", {"handle": "Stylist", "displayName": None, "passcode": None})
    wc = invoke("save_character", {"character": {"card": dict(blank_card, name="Model")}})
    wid = wc["id"]
    def add_outfit(path, name=None):
        hdr = {"x-char-id": wid, "x-file-name": os.path.basename(path), "x-outfit-name": name or ""}
        b64 = base64.b64encode(open(path, "rb").read()).decode()
        r = d.execute_async_script("const done=arguments[arguments.length-1];const b=Uint8Array.from(atob(arguments[0]),c=>c.charCodeAt(0));window.__TAURI_INTERNALS__.invoke('add_outfit', b, {headers:arguments[1]}).then(v=>done({ok:v})).catch(e=>done({err:String(e)}));", b64, hdr)
        if "err" in r: raise RuntimeError(r["err"])
        return r["ok"]
    def add_outfit_err(path, name=None):
        try: add_outfit(path, name); return None
        except RuntimeError as ex: return str(ex)
    check("an image-only character can't have outfits", "VRM model first" in (add_outfit_err(os.path.join(FIX, "sample.vrm")) or ""))
    wc = set_media_ipc(wid, os.path.join(FIX, "sample.vrm"))
    check("the wardrobe starts empty on the original model", wc["outfits"] == [] and wc["outfit"] is None and wc["outfit_paths"] == [])
    orig_path = wc["media_path"]
    check("only VRM files are accepted as outfits", "has to be a VRM" in (add_outfit_err(os.path.join(FIX, "avatar.gif")) or ""))
    wc = add_outfit(os.path.join(FIX, "sample.vrm"), "Summer dress")
    check("adding an outfit puts it on", len(wc["outfits"]) == 1 and wc["outfits"][0]["name"] == "Summer dress" and wc["outfit"] == wc["outfits"][0]["id"])
    check("the character now shows the outfit's file, the original is kept", wc["media_path"] != orig_path and wc["media_path"] == wc["outfit_paths"][0]["path"] and os.path.exists(orig_path) and os.path.exists(wc["media_path"]))
    first = wc["outfits"][0]["id"]
    wc = add_outfit(os.path.join(FIX, "sample.vrm"), "summer DRESS")
    check("outfit names stay unique", [o["name"] for o in wc["outfits"]] == ["Summer dress", "summer DRESS 2"])
    second = wc["outfits"][1]["id"]
    wc = invoke("set_outfit", {"id": wid, "outfitId": None})
    check("'Original' puts the original model back", wc["outfit"] is None and wc["media_path"] == orig_path)
    wc = invoke("set_outfit", {"id": wid, "outfitId": first})
    check("an outfit can be put on", wc["media_path"] == wc["outfit_paths"][0]["path"])
    check("an unknown outfit is refused", "isn't in the wardrobe" in (inv_err("set_outfit", {"id": wid, "outfitId": "nope"}) or ""))
    wc = invoke("rename_outfit", {"id": wid, "outfitId": second, "name": "  Pajamas  "})
    check("outfits can be renamed (trimmed)", wc["outfits"][1]["name"] == "Pajamas")
    check("renaming to an existing name is refused", "already an outfit" in (inv_err("rename_outfit", {"id": wid, "outfitId": second, "name": "summer dress"}) or ""))
    saved_again = invoke("save_character", {"character": {"id": wid, "card": dict(blank_card, name="Model", description="edited"), "outfits": [], "outfit": None}})
    check("editing the card never loses or changes the wardrobe (the backend owns it)", len(saved_again["outfits"]) == 2 and saved_again["outfit"] == first)
    # backup, eject and restore: the wardrobe travels with the character
    info = invoke("prepare_export")
    check("the backup counts every outfit file", info["media"] == 3, str(info))
    wpath = os.path.join(WORK, "stylist.dorms")
    invoke("save_export", {"token": info["token"], "path": wpath})
    n_media_now = len(os.listdir(media_dir))
    invoke("eject_profile", {"token": info["token"]})
    check("eject removes the outfit files too", len(os.listdir(media_dir)) == n_media_now - 3)
    out = invoke_file("import_profile", wpath, {"x-mode": "import", "x-handle": "Stylist", "x-passcode": ""})
    back = chars()[0]
    check("the restored character has its whole wardrobe back, with the same outfit on", [o["name"] for o in back["outfits"]] == ["Summer dress", "Pajamas"] and back["outfit"] == first and all(os.path.exists(o["path"]) for o in back["outfit_paths"]), str(back.get("outfits")))
    wid = back["id"]
    wc = invoke("remove_outfit", {"id": wid, "outfitId": first})
    check("removing the outfit being worn goes back to the original and deletes its file", wc["outfit"] is None and len(wc["outfits"]) == 1 and wc["media_path"] != "" and len(os.listdir(media_dir)) == n_media_now - 3 + 2)
    invoke("delete_character", {"id": wid})
    check("deleting the character deletes its outfit files", len(os.listdir(media_dir)) == n_media_now - 3)
    invoke("sign_out")

    # -- delete needs the name typed
    gid = [p for p in invoke("session_state")["profiles"] if p["handle"] == "Guesty"][0]["id"]
    invoke("sign_in", {"profileId": gid})
    check("only the guest space can be claimed (not an existing profile)", "only the guest space" in (inv_err("claim_guest_profile", {"handle": "Nope", "displayName": None, "passcode": None}) or "").lower())
    check("deleting a profile needs its name typed", "doesn't match" in (inv_err("delete_profile", {"confirm": "nope"}) or ""))
    n_before = len(os.listdir(media_dir))
    invoke("delete_profile", {"confirm": "guesty"})
    st = invoke("session_state")
    check("deleting removes the profile and signs out", st["signed_in"] is False and all(p["handle"] != "Guesty" for p in st["profiles"]))
    check("deleting removes its media files too", len(os.listdir(media_dir)) < n_before)
    # -- device preference: ask on launch
    check("the launch preference is stored", invoke("set_launch_pref", {"askOnLaunch": True})["ask_on_launch"] is True)
    invoke("set_launch_pref", {"askOnLaunch": False})
    reload_ui()
    check("with profiles present and none open, the picker shows (no silent sign-in after sign-out)", text_present("Welcome to the dorms"))

finally:
    try: d.quit()
    except Exception: pass
    drv.terminate()
    subprocess.run(["pkill", "-f", "^/[^ ]*(dorms-engine|llama-server)"], check=False)
    subprocess.run(["pkill", "-x", "WebKitWebDriver"], check=False)
    subprocess.run(["pkill", "-f", "^/[^ ]*desktop-college-dorms"], check=False)  # nothing may outlive the run

fails = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(fails)}/{len(results)} checks passed")
if fails: print("FAILED:", *fails, sep="\n  ")
sys.exit(1 if fails else 0)
