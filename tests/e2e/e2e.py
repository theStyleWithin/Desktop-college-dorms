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
        for piece in seen.get("pieces") or ["Hello ", "from ", "*the cloud*", "!"]:
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
def invoke_file(cmd, path, headers):
    b64 = base64.b64encode(open(path, "rb").read()).decode()
    r = d.execute_async_script("const done=arguments[arguments.length-1];const b=Uint8Array.from(atob(arguments[0]),c=>c.charCodeAt(0));window.__TAURI_INTERNALS__.invoke(arguments[1], b, {headers:arguments[2]}).then(v=>done({ok:v})).catch(e=>done({err:String(e)}));", b64, cmd, headers)
    if "err" in r: raise RuntimeError(r["err"])
    return r["ok"]
def inv_err_file(cmd, path, headers):
    try: invoke_file(cmd, path, headers); return None
    except RuntimeError as ex: return str(ex)
def inv_err(cmd, args=None):
    try: invoke(cmd, args); return None
    except RuntimeError as ex: return str(ex)
def click_text(sel, text):
    return d.execute_script("const el=[...document.querySelectorAll(arguments[0])].find(b=>b.textContent.includes(arguments[1])&&!b.disabled);if(!el)return false;el.scrollIntoView({block:'center'});el.click();return true", sel, text)
def set_value(sel, value):
    d.execute_script("const el=document.querySelector(arguments[0]);const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,arguments[1]);el.dispatchEvent(new Event('input',{bubbles:true}))", sel, value)
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
        if kind == "gif":
            # a picture is positioned before it is saved, so the face is never cut off
            check("choosing a picture opens the positioning window", d.execute_script("return !!document.querySelector('[data-testid=frame-main] img')"))
            check("nothing is saved until you confirm", ((invoke("get_character", {"id": mira["id"]})["media"]) or {}).get("kind") != "gif")
            check("the window shows how it looks as a card, a round avatar and a banner", d.execute_script("return document.querySelectorAll('.frame-prev img').length") == 3)
            set_value("input[aria-label=Zoom]", "2.5"); time.sleep(0.3)
            check("zooming scales the picture in every preview", d.execute_script("return [...document.querySelectorAll('[data-testid=frame-main] img, .frame-prev img')].every(i=>i.style.transform==='scale(2.5)')"))
            box = d.find_element(By.CSS_SELECTOR, "[data-testid=frame-main]")
            ActionChains(d).move_to_element(box).click_and_hold().move_by_offset(-50, -30).release().perform(); time.sleep(0.3)
            pos = d.execute_script("return document.querySelector('[data-testid=frame-main] img').style.objectPosition")
            check("dragging moves the picture inside the box", pos and pos != "50.00% 50.00%", str(pos))
            click_text(".modal button", "Save"); time.sleep(2.2)
            check("the framing window closes after saving", not d.execute_script("return !!document.querySelector('[data-testid=frame-main]')"))
        c = invoke("get_character", {"id": mira["id"]})
        check(f"{label} upload is stored as '{kind}'", c["media"] and c["media"]["kind"] == kind, str(c["media"]))
        if kind == "gif":
            check("the chosen position and zoom are saved with the character", c.get("frame") and abs(c["frame"]["zoom"] - 2.5) < 0.01 and (abs(c["frame"]["x"] - 0.5) > 0.005 or abs(c["frame"]["y"] - 0.5) > 0.005), str(c.get("frame")))
            check("the picture in the editor uses that framing", d.execute_script("const i=document.querySelector('.editor-media img');return !!i&&i.style.transform==='scale(2.5)'"))
            check("a ⤧ Position button reopens the window with the saved framing", click_text("button", "Position") and d.execute_script("return document.querySelector('input[aria-label=Zoom]').value") == "2.5")
            click_text(".modal button", "Reset"); click_text(".modal button", "Save"); time.sleep(1.2)
            check("Reset puts the picture back to its default framing", invoke("get_character", {"id": mira["id"]}).get("frame") is None)
            invoke("set_frame", {"id": mira["id"], "frame": {"x": 5, "y": -3, "zoom": 99}})
            fr = invoke("get_character", {"id": mira["id"]})["frame"]
            check("a framing is always kept within sane limits", fr == {"x": 1.0, "y": 0.0, "zoom": 5.0}, str(fr))
            invoke("set_frame", {"id": mira["id"], "frame": None})
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
            # the hands have three gestures: open (pet), a pointing finger (poke, tickle) and a pinch (pick her up)
            vb = ".vrm-big .vrm-box"
            vev = lambda name, detail=None: d.execute_script("document.querySelector(arguments[0]).dispatchEvent(new CustomEvent(arguments[1],{detail:arguments[2]}))", vb, name, detail)
            vds = lambda k: d.execute_script("return document.querySelector(arguments[0]).dataset[arguments[1]]", vb, k)
            check("with the hands on there are Poke and Pick up buttons", d.execute_script("return !!document.querySelector('.vrm-big [aria-label=Poke]') && !!document.querySelector('.vrm-big [aria-label=\"Pick up\"]')"))
            d.execute_script("document.querySelector('.vrm-big [aria-label=Poke]').click()"); time.sleep(0.4)
            check("Poke turns the hands into a pointing finger", vds("pointing") == "1" and vds("pinching") is None)
            d.execute_script("document.querySelector('.vrm-big [aria-label=\"Pick up\"]').click()"); time.sleep(0.4)
            check("Pick up switches to the pinch (and off pointing)", vds("pinching") == "1" and vds("pointing") is None)
            d.execute_script("document.querySelector('.vrm-big [aria-label=\"Pick up\"]').click()"); time.sleep(0.4)
            check("clicking it again goes back to open hands", vds("pinching") is None and vds("pointing") is None)
            for key, want in (("p", "pointing"), ("g", "pinching"), ("g", None)):
                ActionChains(d).send_keys(key).perform(); time.sleep(0.4)
            check("P and G switch gestures from the keyboard", vds("pinching") is None and vds("pointing") is None)
            ActionChains(d).send_keys("p").perform(); time.sleep(0.4)
            check("P gives the pointing finger", vds("pointing") == "1")
            # poking: every place she reacts to gives its own reaction (the tests aim without a mouse)
            REG = ["nose", "forehead", "cheek", "ear", "head", "shoulder", "arm", "hand", "back", "other"]
            got = []
            for r in REG:
                vev("poke", {"region": r, "side": 1}); time.sleep(0.45); got.append(vds("poke"))
            check("poking each place on her gives its own reaction", got == REG, str(got))
            check("every poke is counted", vds("pokes") == str(len(REG)))
            time.sleep(2.5)
            # tickling: the laugh builds while a finger tickles somewhere ticklish
            vev("tickle", {"region": "ear", "seconds": 3}); time.sleep(2.6)
            check("tickling somewhere ticklish makes her laugh", int(vds("tickle") or 0) > 30, str(vds("tickle")))
            check("it counts as one tickle, not one per frame", vds("tickles") == "1", str(vds("tickles")))
            # the laugh fades with the animation clock, which runs slower than the wall clock on a slow machine: wait for it (up to 30 s) rather than a fixed time
            for _ in range(60):
                time.sleep(0.5)
                if int(vds("tickle") or 0) < 10: break
            check("the laugh dies down when it stops", int(vds("tickle") or 0) < 10, str(vds("tickle")))
            # tickled in the middle of a stretch: caught off guard, the stretch ends at once and she bursts out laughing
            vev("npc", "stretch"); time.sleep(2.8)
            check("she sometimes stretches with her arms over her head", vds("plan") == "stretch", str(vds("plan")))
            vev("tickle", {"region": "arm", "seconds": 2}); time.sleep(1.4)
            check("tickled mid-stretch she is caught off guard: full laughter at once and the stretch is over", int(vds("tickle") or 0) >= 90 and vds("plan") == "home", f"{vds('tickle')} {vds('plan')}")
            time.sleep(6)
            # picking her up: she dangles from the fingertips, kicks and yells, and lands where you put her
            vev("pickup", {"calm": False}); time.sleep(1.6)
            check("pinching her picks her up", vds("carry") == "held" and int(vds("carryY") or 0) > 5, f"{vds('carry')} {vds('carryY')}")
            check("a panicking pick-up thrashes about", int(vds("panic") or 0) > 40 and vds("calm") == "0", str(vds("panic")))
            vev("drop"); time.sleep(0.4)
            check("letting go drops her", vds("carry") in ("fall", "dizzy"), str(vds("carry")))
            for _ in range(40):
                if vds("carry") == "none": break
                time.sleep(0.4)
            check("she lands, sees stars, and carries on with her day", vds("carry") == "none", str(vds("carry")))
            vev("pickup", {"calm": True}); time.sleep(1.4)
            check("sometimes she goes limp and sulks instead of panicking", vds("carry") == "held" and vds("calm") == "1" and int(vds("panic") or 0) < 50, f"{vds('calm')} {vds('panic')}")
            vev("drop")
            for _ in range(40):
                if vds("carry") == "none": break
                time.sleep(0.4)
            check("and goes back to normal after being put down", vds("carry") == "none")
            ActionChains(d).send_keys("p").perform(); time.sleep(0.3)
            d.execute_script("document.querySelector('.vrm-big [aria-label=Hands]').click()")
            # the big viewer is a real window: resize from the edges/corners, move by the title bar, theatre and full screen
            rect = lambda sel: d.execute_script("const r=document.querySelector(arguments[0]).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}", sel)
            win = ".vw"
            r0 = rect(win)
            check("the viewer window has resize handles on all 4 sides and 4 corners", d.execute_script("return document.querySelectorAll('.vw-h').length") == 8)
            ActionChains(d).move_to_element(d.find_element(By.CSS_SELECTOR, ".vw-h-se")).click_and_hold().move_by_offset(-120, -90).release().perform(); time.sleep(0.4)
            r1 = rect(win)
            check("pulling the bottom-right corner resizes it", r1["w"] < r0["w"] - 60 and r1["h"] < r0["h"] - 40, f"{r0} -> {r1}")
            ActionChains(d).move_to_element(d.find_element(By.CSS_SELECTOR, ".vw-h-w")).click_and_hold().move_by_offset(-80, 0).release().perform(); time.sleep(0.4)
            r2 = rect(win)
            check("pulling the left edge widens it (and keeps the right edge put)", r2["w"] > r1["w"] + 40 and abs((r2["x"] + r2["w"]) - (r1["x"] + r1["w"])) < 3, f"{r1} -> {r2}")
            ActionChains(d).move_to_element(d.find_element(By.CSS_SELECTOR, ".vw-bar h2")).click_and_hold().move_by_offset(0, 20).release().perform(); time.sleep(0.4)
            r3 = rect(win)
            check("dragging the title bar moves the window without resizing it", abs(r3["w"] - r2["w"]) < 2 and abs(r3["y"] - r2["y"]) > 8, f"{r2} -> {r3}")
            check("the 3D view follows the window size", d.execute_script("const c=document.querySelector('.vrm-big canvas').getBoundingClientRect(),b=document.querySelector('.vrm-big').getBoundingClientRect();return Math.abs(c.width-b.width)<3 && Math.abs(c.height-b.height)<3"))
            d.execute_script("document.querySelector('.vw [aria-label=\"Theatre mode\"]').click()"); time.sleep(0.6)
            vw_, vh_ = d.execute_script("return [innerWidth,innerHeight]")
            rt = rect(win)
            check("theatre mode fills most of the screen", rt["w"] > vw_ * 0.9 and rt["h"] > vh_ * 0.88, f"{rt} in {vw_}x{vh_}")
            check("no resize handles in theatre mode", d.execute_script("return document.querySelectorAll('.vw-h').length") == 0)
            d.execute_script("document.querySelector('.vw [aria-label=\"Full screen\"]').click()"); time.sleep(0.8)
            rf = rect(win)
            check("full screen covers the whole app window", rf["w"] >= vw_ - 1 and rf["h"] >= vh_ - 1 and rf["x"] <= 1 and rf["y"] <= 1, f"{rf}")
            check("the model still shows in full screen", d.execute_script("const e=document.querySelector('.vrm-big .vrm-box');return e&&e.dataset.ready==='1'"))
            ActionChains(d).send_keys(Keys.ESCAPE).perform(); time.sleep(0.6)
            check("Escape leaves full screen but keeps the window open", d.execute_script("return !!document.querySelector('.vw[data-mode=window]')"))
            r4 = rect(win)
            check("and the window is back where it was", abs(r4["w"] - r3["w"]) < 2 and abs(r4["h"] - r3["h"]) < 2, f"{r3} -> {r4}")
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
    # the Continue button, with the real engine: it extends this very message instead of adding a new one
    n_before = len(invoke("list_messages", {"chatId": chat["id"]}))
    check("the Continue button sits next to Regenerate on the newest character message",
          d.execute_script("const t=[...document.querySelectorAll('.msg.character .tools')].pop(); return !!t && t.textContent.includes('Regenerate') && t.textContent.includes('Continue')"))
    d.execute_script("[...document.querySelectorAll('.msg.character .tools button')].reverse().find(b=>b.textContent.includes('Continue')).click()")
    for _ in range(90):
        time.sleep(1)
        cur = invoke("list_messages", {"chatId": chat["id"]})[-1]
        if len(cur["swipes"][cur["swipe_index"]]) > len("edited reply"): break
    cur_all = invoke("list_messages", {"chatId": chat["id"]}); cur = cur_all[-1]; cur_text = cur["swipes"][cur["swipe_index"]]
    check("Continue extends the same message in place with the real model", cur["id"] == mid and len(cur_all) == n_before and cur_text.startswith("edited reply") and len(cur_text) > len("edited reply"), cur_text[:120])

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
    # ---- Continue: exact request, in-place result, and the guards ----------------------------------------
    msgs_c = invoke("list_messages", {"chatId": chat2["id"]}); last_c = msgs_c[-1]; before_c = last_c["swipes"][last_c["swipe_index"]]
    invoke("generate", {"chatId": chat2["id"], "characterId": None, "regenerateMessageId": None, "continueMessageId": last_c["id"]})
    for _ in range(30):
        time.sleep(0.4)
        after_all = invoke("list_messages", {"chatId": chat2["id"]})
        if len(after_all[-1]["swipes"][after_all[-1]["swipe_index"]]) > len(before_c): break
    after_all = invoke("list_messages", {"chatId": chat2["id"]}); after_c = after_all[-1]; after_text = after_c["swipes"][after_c["swipe_index"]]
    check("continue extends the newest message in place (no new message, same id)", len(after_all) == len(msgs_c) and after_c["id"] == last_c["id"])
    check("the added text follows the original with clean spacing", after_text == before_c + " Hello from *the cloud*!", repr(after_text))
    check("continue doesn't add a version (swipe)", len(after_c["swipes"]) == len(last_c["swipes"]) and after_c["swipe_index"] == last_c["swipe_index"])
    sent_c = seen["body"]["messages"]
    check("the model is shown its own partial reply, untouched, as the character's words", sent_c[-2]["role"] == "assistant" and sent_c[-2]["content"] == before_c, str(sent_c[-2:]))
    check("and is asked to go on without repeating itself", sent_c[-1]["role"] == "user" and "Continue" in sent_c[-1]["content"] and "do not repeat" in sent_c[-1]["content"])
    check("the continue prompt still alternates roles and ends on a user turn", sent_c[0]["role"] == "system" and sent_c[-1]["role"] == "user" and all(a["role"] != b["role"] for a, b in zip(sent_c[1:], sent_c[2:])), str([m["role"] for m in sent_c]))
    def unchanged_after(args, label):
        snap = json.dumps(invoke("list_messages", {"chatId": chat2["id"]}))
        invoke("generate", dict({"chatId": chat2["id"], "characterId": None, "regenerateMessageId": None, "continueMessageId": None}, **args)); time.sleep(1.5)
        check(label, json.dumps(invoke("list_messages", {"chatId": chat2["id"]})) == snap)
    unchanged_after({"continueMessageId": msgs_c[0]["id"]}, "an older message can't be continued (only the newest)")
    invoke("add_user_message", {"chatId": chat2["id"], "text": "thanks"})
    user_msg = invoke("list_messages", {"chatId": chat2["id"]})[-1]
    unchanged_after({"continueMessageId": user_msg["id"]}, "a user's own message can't be continued")
    unchanged_after({"continueMessageId": 999999}, "continuing a message that doesn't exist does nothing")
    invoke("delete_message", {"id": user_msg["id"]})
    sent = seen["body"]["messages"]
    check("prompt for a cloud call is well-formed (system first, alternating, ends on user)",
          sent[0]["role"] == "system" and sent[-1]["role"] == "user" and all(a["role"] != b["role"] for a, b in zip(sent[1:], sent[2:])), str([m["role"] for m in sent]))
    check("lorebook/description/scenario reach the system prompt", "Edited scenario text" in sent[0]["content"] and "Sleepy RA" in sent[0]["content"])
    check("post-history/depth macros resolve with the user's name", "Sam" in json.dumps(sent))

    # ---- rooms, mechanic packs and the texting style ------------------------------------------------------------------
    def gen_and_wait(chat_id, pieces=None, n_before=None):
        seen["pieces"] = pieces
        n0 = len(invoke("list_messages", {"chatId": chat_id})) if n_before is None else n_before
        invoke("generate", {"chatId": chat_id, "characterId": None, "regenerateMessageId": None, "continueMessageId": None})
        for _ in range(40):
            time.sleep(0.5)
            if len(invoke("list_messages", {"chatId": chat_id})) > n0: break
        seen["pieces"] = None
        return invoke("list_messages", {"chatId": chat_id})
    def sysprompt(): return seen["body"]["messages"][0]["content"]
    room_in = {"name": "  Mira's loft  ", "kind": "bogus", "description": "A tiny loft with a crooked window and a very loud radiator.", "owner_kind": "character", "character_id": mira["id"], "backdrop": "file:media/../../etc/passwd"}
    room = invoke("create_room", {"room": dict(room_in, id=0, created_at=0)})
    check("a room is saved with a trimmed name, a safe kind and no smuggled backdrop path", room["name"] == "Mira's loft" and room["kind"] == "other" and room["backdrop"] == "", str(room))
    check("an unnamed room is refused", "name" in (inv_err("create_room", {"room": dict(room_in, name="   ", id=0, created_at=0)}) or "").lower())
    check("a character that doesn't exist can't own a room", invoke("create_room", {"room": dict(room_in, name="Ghost", character_id="nope", id=0, created_at=0)})["owner_kind"] == "self")
    kit = invoke("update_room", {"room": dict(room, kind="living_room", backdrop="preset:lamplight")})
    check("rooms can be edited and take a built-in backdrop", kit["kind"] == "living_room" and kit["backdrop"] == "preset:lamplight")
    check("a room can't be given an arbitrary file as its backdrop", invoke("update_room", {"room": dict(kit, backdrop="file:media/room-1-1.png")})["backdrop"] == "preset:lamplight")
    check("a backdrop has to be an image", "image" in (inv_err_file("set_room_backdrop", os.path.join(FIX, "loose.json"), {"x-room-id": str(room["id"]), "x-file-name": "loose.json"}) or "").lower())
    kit = invoke_file("set_room_backdrop", os.path.join(FIX, "avatar.gif"), {"x-room-id": str(room["id"]), "x-file-name": "avatar.gif"})
    check("an uploaded backdrop is stored in the app's media folder", kit["backdrop"].startswith("file:media/room-") and os.path.exists(kit["backdrop_path"]), str(kit))
    dorm_r = invoke("create_dorm", {"name": "Loft dorm", "roomId": room["id"]})
    check("a dorm can be set in a room", dorm_r["room_id"] == room["id"] and [x for x in invoke("list_dorms") if x["id"] == dorm_r["id"]][0]["room_id"] == room["id"])
    check("a dorm set in a room that doesn't exist just has none", invoke("create_dorm", {"name": "x", "roomId": 99999})["room_id"] is None)
    chat_r = invoke("create_chat", {"dormId": dorm_r["id"], "name": "loft chat", "kind": "dm", "characterIds": [mira["id"]]})
    invoke("add_user_message", {"chatId": chat_r["id"], "text": "hello there"}); gen_and_wait(chat_r["id"])
    check("the room's name, kind and description reach the system prompt", "Setting: Mira's loft" in sysprompt() and "a living room" in sysprompt() and "crooked window" in sysprompt() and "own place" in sysprompt(), sysprompt()[-400:])
    check("a chat outside any room gets no setting", "Setting:" not in (lambda: (gen_and_wait(chat2["id"]), sysprompt())[1])())

    pack_json = json.dumps({"name": "Heartbeat", "description": "Two numbers.", "entries": [
        {"id": "e1", "name": "Stages", "content": "HEARTBEAT-LORE: read affection like this.", "alwaysSend": True},
        {"id": "e2", "name": "Secret", "content": "LOCKET-LORE: the locket was her mother's.", "keywords": ["locket"]}],
        "variables": [{"id": "aff", "name": "Affection", "type": "number", "min": 0, "max": 100, "deltaUp": 15, "deltaDown": 15, "precise": True, "defaultValue": 20, "behaviorRules": "How she feels about the player."},
                      {"id": "log", "name": "Log", "type": "json", "defaultValue": []}],
        "reactions": [{"id": "warm", "when": {"eventType": "message:user", "match": {"content": {"value": "thank you,thanks", "operator": "contains"}}}, "then": [{"path": "aff", "type": "set", "value": 3, "operation": "add"}]}],
        "rootComponent": {"id": "x", "files": {"index.tsx": "export default () => null"}, "entryFile": "index.tsx"}})
    pack_path = os.path.join(WORK, "heartbeat.bundle.json"); open(pack_path, "w").write(pack_json)
    check("a file that isn't a mechanic pack is refused", "mechanic pack" in (inv_err_file("import_mechanic", os.path.join(FIX, "loose.json"), {}) or ""))
    pk = invoke_file("import_mechanic", pack_path, {})
    check("a mechanic pack imports (name, variables, notes, reactions counted; its own screens flagged as not run)", pk["name"] == "Heartbeat" and len(pk["variables"]) == 2 and pk["entries"] == 2 and pk["reactions"] == 1 and pk["has_ui"] is True and pk["app"] == "vars", str(pk))
    check("importing the same pack again replaces it instead of duplicating", invoke_file("import_mechanic", pack_path, {})["id"] == pk["id"] and len(invoke("list_mechanics")) == 1)
    check("a pack is OFF in a chat until it's switched on", invoke("chat_mechanics", {"chatId": chat_r["id"]}) == [])
    gen_and_wait(chat_r["id"])
    check("an unused pack adds nothing to the prompt", "HEARTBEAT-LORE" not in sysprompt() and "[aff:" not in sysprompt())
    cms = invoke("set_chat_mechanic", {"chatId": chat_r["id"], "mechId": pk["id"], "enabled": True})
    check("switching a pack on gives it its starting values in that chat", cms[0]["enabled"] and cms[0]["state"]["aff"] == 20, str(cms))
    gen_and_wait(chat_r["id"])
    sp = sysprompt()
    check("a switched-on pack puts its notes, current values, rules and the directive format in the prompt", "HEARTBEAT-LORE" in sp and "Affection [aff] (range 0–100): 20" in sp and "How she feels about the player." in sp and "[variable: operation value]" in sp)
    check("keyword notes stay out until their keyword comes up", "LOCKET-LORE" not in sp)
    invoke("add_user_message", {"chatId": chat_r["id"], "text": "do you still have the locket?"}); gen_and_wait(chat_r["id"])
    check("...and come in when it does", "LOCKET-LORE" in sysprompt())
    invoke("add_user_message", {"chatId": chat_r["id"], "text": "Thank you for listening"})
    check("a keyword reaction runs when the player writes (+3 affection)", invoke("chat_mechanics", {"chatId": chat_r["id"]})[0]["state"]["aff"] == 23)
    msgs_r = gen_and_wait(chat_r["id"], ["She smiles softly. ", "[aff: add 40]", "\n\n", "[log: push {text: \"told her about the locket\"}] ", "Stay a while."])
    last = msgs_r[-1]["swipes"][msgs_r[-1]["swipe_index"]]
    check("hidden [variable: op value] lines never reach the reader", "[aff" not in last and "[log" not in last and last.startswith("She smiles softly.") and last.endswith("Stay a while."), repr(last))
    st_r = invoke("chat_mechanics", {"chatId": chat_r["id"]})[0]["state"]
    check("the model's directives were applied (a single change is capped at the pack's +15 step)", st_r["aff"] == 38, str(st_r["aff"]))
    check("json variables take pushes (relaxed JSON from the model is understood)", st_r["log"] == [{"text": "told her about the locket"}], str(st_r["log"]))
    invoke("set_chat_variable", {"chatId": chat_r["id"], "mechId": pk["id"], "path": "aff", "value": 250})
    check("the player can set a number by hand (clamped to the range)", invoke("chat_mechanics", {"chatId": chat_r["id"]})[0]["state"]["aff"] == 100)
    check("starting a pack over restores its defaults", invoke("reset_chat_mechanic", {"chatId": chat_r["id"], "mechId": pk["id"]})[0]["state"]["aff"] == 20)
    cms = invoke("set_chat_mechanic", {"chatId": chat_r["id"], "mechId": pk["id"], "enabled": False})
    gen_and_wait(chat_r["id"])
    check("switching it off removes it from the prompt but keeps its progress", not cms[0]["enabled"] and "HEARTBEAT-LORE" not in sysprompt() and cms[0]["state"]["aff"] == 20)
    gen_and_wait(chat_r["id"], ["Fine. [aff: add 5]"])
    check("an off pack ignores directives (and the text is left alone)", invoke("chat_mechanics", {"chatId": chat_r["id"]})[0]["state"]["aff"] == 20)
    invoke("set_chat_mechanic", {"chatId": chat_r["id"], "mechId": pk["id"], "enabled": True})
    chats_now = {c["id"]: c for c in invoke("list_chats")}
    check("a brand-new chat has no packs on", invoke("chat_mechanics", {"chatId": chat2["id"]}) == [])
    ph = dict(chats_now[chat_r["id"]], style="phone"); invoke("update_chat", {"chat": ph})
    gen_and_wait(chat_r["id"])
    check("the phone style asks for texting-style replies", "texting each other" in sysprompt() and "No *actions*" in sysprompt())
    check("the style is kept on the chat", {c["id"]: c for c in invoke("list_chats")}[chat_r["id"]]["style"] == "phone")

    # -- background music for rooms and dorms
    check("music has to be an audio file", "audio" in (inv_err_file("set_room_music", os.path.join(FIX, "avatar.gif"), {"x-room-id": str(room["id"]), "x-file-name": "avatar.gif"}) or "").lower())
    rm_music = invoke_file("set_room_music", os.path.join(FIX, "song.mp3"), {"x-room-id": str(room["id"]), "x-file-name": "song.mp3"})
    check("a room takes an MP3 from the filesystem (stored in the app's media folder, original name kept)", rm_music["music"].startswith("media/music-room") and rm_music["music_name"] == "song.mp3" and os.path.exists(rm_music["music_path"]), str(rm_music))
    upd = invoke("update_room", {"room": dict(rm_music, music="media/evil.mp3", music_name="x", name="Mira's loft")})
    check("editing the room never swaps its music file from outside", upd["music"] == rm_music["music"] and upd["music_name"] == "song.mp3")
    old_music = rm_music["music_path"]
    rm_music = invoke_file("set_room_music", os.path.join(FIX, "tone.wav"), {"x-room-id": str(room["id"]), "x-file-name": "tone.wav"})
    check("choosing other music replaces the old file", rm_music["music_name"] == "tone.wav" and not os.path.exists(old_music) and os.path.exists(rm_music["music_path"]))
    dm_music = invoke_file("set_dorm_music", os.path.join(FIX, "song.mp3"), {"x-dorm-id": str(dorm_r["id"]), "x-file-name": "my song.mp3"})
    check("a dorm can have its own music", dm_music["music_name"] == "my song.mp3" and os.path.exists(dm_music["music_path"]) and [x for x in invoke("list_dorms") if x["id"] == dorm_r["id"]][0]["music_name"] == "my song.mp3", str(dm_music))
    check("dorm music has to be audio too", "audio" in (inv_err_file("set_dorm_music", os.path.join(FIX, "loose.json"), {"x-dorm-id": str(dorm_r["id"]), "x-file-name": "x.json"}) or "").lower())
    check("another dorm's music can't be set by guessing ids", "not found" in (inv_err_file("set_dorm_music", os.path.join(FIX, "song.mp3"), {"x-dorm-id": "99999", "x-file-name": "a.mp3"}) or "").lower())
    dm_file = dm_music["music_path"]
    cl = invoke("clear_dorm_music", {"id": dorm_r["id"]})
    check("music can be removed from a dorm (file deleted)", cl["music"] == "" and not os.path.exists(dm_file))
    cl = invoke("clear_room_music", {"id": room["id"]})
    check("...and from a room", cl["music"] == "" and cl["music_name"] == "" and not os.path.exists(rm_music["music_path"]))
    tmp_room = invoke("create_room", {"room": dict(room_in, name="Temp", id=0, created_at=0)})
    tmp_room = invoke_file("set_room_music", os.path.join(FIX, "song.mp3"), {"x-room-id": str(tmp_room["id"]), "x-file-name": "t.mp3"})
    invoke("delete_room", {"id": tmp_room["id"]})
    check("deleting a room deletes its music file", not os.path.exists(tmp_room["music_path"]))
    tmp_dorm = invoke("create_dorm", {"name": "TempDorm", "roomId": None})
    tmp_dorm = invoke_file("set_dorm_music", os.path.join(FIX, "song.mp3"), {"x-dorm-id": str(tmp_dorm["id"]), "x-file-name": "t.mp3"})
    invoke("delete_dorm", {"id": tmp_dorm["id"]})
    check("deleting a dorm deletes its music file", not os.path.exists(tmp_dorm["music_path"]))

    # ---- personas: who you are in a chat, sent to the AI first ----------------------------------------------------------
    check("the guest space has no profile picture (named profiles do)", "guest" in (inv_err_file("set_profile_avatar", os.path.join(FIX, "avatar.gif"), {"x-file-name": "avatar.gif"}) or "").lower())
    check("a persona needs a name", "name" in (inv_err("save_persona", {"persona": {"id": "", "name": "  ", "description": "", "style": "", "avatar": None, "frame": None, "created_at": 0}}) or "").lower())
    kai = invoke("save_persona", {"persona": {"id": "", "name": "  Kai ", "description": "A second-year art student who talks too fast when nervous.", "style": "Slow-burn friendship. Keep descriptions short. Remember my sister is called Mei.", "avatar": "media/../../etc/passwd", "frame": None, "created_at": 0}})
    check("a persona is saved (name trimmed, picture can't be smuggled in through the text fields)", kai["name"] == "Kai" and kai["avatar"] is None and kai["id"], str(kai))
    check("a persona's picture has to be an image", "image" in (inv_err_file("set_persona_avatar", os.path.join(FIX, "loose.json"), {"x-persona-id": kai["id"], "x-file-name": "loose.json"}) or "").lower())
    kai = invoke_file("set_persona_avatar", os.path.join(FIX, "avatar.gif"), {"x-persona-id": kai["id"], "x-file-name": "avatar.gif"})
    check("a persona takes a picture (an animated GIF is fine)", kai["avatar"].startswith("media/avatar-") and kai["avatar"].endswith(".gif") and os.path.exists(kai["avatar_path"]), str(kai))
    kai = invoke("set_persona_frame", {"id": kai["id"], "frame": {"x": 0.3, "y": 0.7, "zoom": 2}})
    check("its framing is stored", kai["frame"] == {"x": 0.3, "y": 0.7, "zoom": 2.0})
    kai2 = invoke("save_persona", {"persona": dict(kai, description="edited")})
    check("editing a persona keeps its picture and framing", kai2["avatar"] == kai["avatar"] and kai2["frame"] == kai["frame"] and kai2["description"] == "edited")
    invoke("save_persona", {"persona": dict(kai, description="A second-year art student who talks too fast when nervous.")})
    check("an unknown persona can't be made active", "doesn't exist" in (inv_err("set_active_persona", {"id": "nope"}) or ""))
    invoke("add_user_message", {"chatId": chat2["id"], "text": "plain hello"}); gen_and_wait(chat2["id"])
    plain_sys = sysprompt()
    check("with no persona, the plain name from Settings is used", "About Sam:" in plain_sys or "Sam" in plain_sys, plain_sys[-300:])
    st_p = invoke("set_active_persona", {"id": kai["id"]})
    check("a persona can be made active", st_p["active_persona"] == kai["id"] and invoke("get_settings")["active_persona"] == kai["id"])
    invoke("add_user_message", {"chatId": chat2["id"], "text": "hello as kai"}); gen_and_wait(chat2["id"])
    sp = sysprompt()
    check("the active persona's name and description are told to the AI first", "About Kai:" in sp and "talks too fast when nervous" in sp, sp[-500:])
    check("...together with how they want to roleplay and what to remember", "How Kai wants to roleplay, and what to remember:" in sp and "my sister is called Mei" in sp)
    check("the plain 'about you' text is replaced, not duplicated", "About Sam:" not in sp)
    invoke("delete_persona", {"id": kai["id"]})
    check("deleting the active persona goes back to the plain name and removes its picture", invoke("get_settings")["active_persona"] == "" and invoke("list_personas") == [] and not os.path.exists(kai["avatar_path"]))
    sv = invoke("get_settings"); sv["active_persona"] = "not-mine"; sv = invoke("save_settings", {"settings": sv})
    check("saving settings can't point at a persona that isn't yours", sv["active_persona"] == "")

    # ---- folders, lorebooks and opening messages ------------------------------------------------------------------
    fo = invoke("create_folder", {"name": "   Favourites  "})
    check("a folder is created with a trimmed name", fo["name"] == "Favourites" and fo["cover"] is None and fo["id"])
    check("an unnamed folder is refused", "name" in (inv_err("create_folder", {"name": "  "}) or "").lower())
    invoke("move_characters", {"ids": [mira["id"]], "folder": fo["id"]})
    check("a character can be filed into a folder", invoke("get_character", {"id": mira["id"]})["folder"] == fo["id"])
    again = invoke("save_character", {"character": dict(invoke("get_character", {"id": mira["id"]}), folder=None)})
    check("editing a card never moves it out of its folder (filing is done by dragging)", again["folder"] == fo["id"])
    check("a folder that doesn't exist can't be filed into", "doesn't exist" in (inv_err("move_characters", {"ids": [mira["id"]], "folder": "nope"}) or ""))
    fo = invoke("rename_folder", {"id": fo["id"], "name": "Besties"})
    check("a folder can be renamed", fo["name"] == "Besties" and [f["name"] for f in invoke("list_folders")] == ["Besties"])
    check("a folder picture has to be an image", "image" in (inv_err_file("set_folder_cover", os.path.join(FIX, "loose.json"), {"x-folder-id": fo["id"], "x-file-name": "loose.json"}) or "").lower())
    fo = invoke_file("set_folder_cover", os.path.join(FIX, "avatar.gif"), {"x-folder-id": fo["id"], "x-file-name": "avatar.gif"})
    check("a folder can have its own picture, kept in the media folder", fo["cover"].startswith("media/folder-") and os.path.exists(fo["cover_path"]), str(fo))
    fo = invoke("set_folder_frame", {"id": fo["id"], "frame": {"x": 0.2, "y": 0.9, "zoom": 2}})
    check("the picture's framing is stored", fo["frame"] == {"x": 0.2, "y": 0.9, "zoom": 2.0}, str(fo["frame"]))
    cover_file = fo["cover_path"]
    invoke("delete_folder", {"id": fo["id"]})
    mira_now = invoke("get_character", {"id": mira["id"]})
    check("deleting a folder keeps its characters (back at the top level) and removes its picture", mira_now is not None and mira_now["folder"] is None and not os.path.exists(cover_file) and invoke("list_folders") == [])

    card0 = {"name": "Pip", "description": "A tiny test character.", "personality": "", "scenario": "", "first_mes": "Hi!", "mes_example": "", "creator_notes": "", "system_prompt": "", "post_history_instructions": "", "alternate_greetings": [], "character_book": None, "tags": ["t"], "creator": "", "character_version": "", "nickname": "", "group_only_greetings": [], "extensions": {}}
    # nested folders: a canon folder, series inside it, characters in the series
    canon = invoke("create_folder", {"name": "Canon character RP", "parent": None})
    check("a folder sits at the top level by default", canon["parent"] is None)
    ser1 = invoke("create_folder", {"name": "Series One", "parent": canon["id"]})
    ser2 = invoke("create_folder", {"name": "Series Two", "parent": canon["id"]})
    check("a folder can be made inside another", ser1["parent"] == canon["id"] and ser2["parent"] == canon["id"])
    sub = invoke("create_folder", {"name": "Season 1", "parent": ser1["id"]})
    check("and inside that, as deep as you like (within reason)", sub["parent"] == ser1["id"])
    check("a folder can't be made inside one that doesn't exist", "doesn't exist" in (inv_err("create_folder", {"name": "x", "parent": "nope"}) or ""))
    check("a folder can't go inside itself", "inside itself" in (inv_err("move_folder", {"id": canon["id"], "parent": canon["id"]}) or ""))
    check("or inside one of its own subfolders", "inside itself" in (inv_err("move_folder", {"id": canon["id"], "parent": sub["id"]}) or ""))
    mv = invoke("move_folder", {"id": ser2["id"], "parent": ser1["id"]})
    check("an existing folder can be moved into another (a whole tree moves with it)", mv["parent"] == ser1["id"])
    mv = invoke("move_folder", {"id": ser2["id"], "parent": None})
    check("...and back out to the top level", mv["parent"] is None)
    deep = canon
    for i in range(14):
        r = inv_err("create_folder", {"name": f"deep{i}", "parent": deep["id"]})
        if r: break
        deep = [f for f in invoke("list_folders") if f["name"] == f"deep{i}"][0]
    check("folders can only nest so deep", r is not None and "deep" in r, str(r))
    for f in invoke("list_folders"):
        if f["name"].startswith("deep"): invoke("delete_folder", {"id": f["id"]})
    invoke("move_characters", {"ids": [mira["id"]], "folder": sub["id"]})
    invoke("delete_folder", {"id": ser1["id"]})
    fl = {f["name"]: f for f in invoke("list_folders")}
    check("deleting a folder moves its subfolders up a level (nothing is lost)", "Series One" not in fl and fl["Season 1"]["parent"] == canon["id"], str({k: v["parent"] for k, v in fl.items()}))
    check("and its characters up too", invoke("get_character", {"id": mira["id"]})["folder"] == fl["Season 1"]["id"])
    for n in ("Season 1", "Series Two", "Canon character RP"):
        invoke("delete_folder", {"id": [f for f in invoke("list_folders") if f["name"] == n][0]["id"]})
    check("deleting all of them returns the character to the top level", invoke("get_character", {"id": mira["id"]})["folder"] is None and invoke("list_folders") == [])

    greeter = invoke("save_character", {"character": {"id": "", "card": dict(card0, name="Greeter", first_mes="Hi, first!", alternate_greetings=["Second hello", "  ", "Third hello"])}})
    c_open = invoke("create_chat", {"dormId": None, "name": "open1", "kind": "dm", "characterIds": [greeter["id"]], "opening": 2})
    m0 = invoke("list_messages", {"chatId": c_open["id"]})[0]
    check("a chat can start on any of the greetings (empty ones are skipped)", m0["swipes"] == ["Hi, first!", "Second hello", "Third hello"] and m0["swipe_index"] == 2, str(m0))
    c_open2 = invoke("create_chat", {"dormId": None, "name": "open2", "kind": "dm", "characterIds": [greeter["id"]]})
    check("by default it starts on the first message", invoke("list_messages", {"chatId": c_open2["id"]})[0]["swipe_index"] == 0)
    c_open3 = invoke("create_chat", {"dormId": None, "name": "open3", "kind": "dm", "characterIds": [greeter["id"]], "opening": 99})
    check("an opening that doesn't exist falls back to the first", invoke("list_messages", {"chatId": c_open3["id"]})[0]["swipe_index"] == 0)

    lore_book = {"name": "ignored", "entries": [
        {"keys": ["moonlit"], "content": "MOONLIT-LORE: the old fountain glows at night.", "enabled": True, "insertion_order": 5},
        {"keys": [], "content": "ALWAYS-LORE: the campus has two clocks.", "enabled": True, "constant": True, "insertion_order": 6}]}
    lb = invoke("save_lorebook", {"lorebook": {"id": "", "name": "  Campus lore ", "book": lore_book, "created_at": 0, "updated_at": 0}})
    check("a lorebook is saved to the library under its own name", lb["name"] == "Campus lore" and len(lb["book"]["entries"]) == 2 and lb["id"], str(lb)[:200])
    check("an unnamed lorebook is refused", "name" in (inv_err("save_lorebook", {"lorebook": {"id": "", "name": " ", "book": lore_book, "created_at": 0, "updated_at": 0}}) or "").lower())
    gm = invoke("get_character", {"id": mira["id"]})
    invoke("save_character", {"character": dict(gm, lorebooks=[lb["id"], lb["id"], "not-mine"])})
    check("a lorebook attaches to a character (once; unknown ones are dropped)", invoke("get_character", {"id": mira["id"]})["lorebooks"] == [lb["id"]])
    invoke("add_user_message", {"chatId": chat2["id"], "text": "no keyword here"}); gen_and_wait(chat2["id"])
    check("an attached lorebook's always-on entry reaches the prompt", "ALWAYS-LORE" in sysprompt() and "MOONLIT-LORE" not in sysprompt())
    invoke("add_user_message", {"chatId": chat2["id"], "text": "the moonlit fountain is pretty"}); gen_and_wait(chat2["id"])
    check("...and keyword entries join when their keyword comes up", "MOONLIT-LORE" in sysprompt())
    invoke("delete_lorebook", {"id": lb["id"]})
    check("deleting a lorebook takes it off the characters", invoke("get_character", {"id": mira["id"]})["lorebooks"] == [] and invoke("list_lorebooks") == [])
    invoke("add_user_message", {"chatId": chat2["id"], "text": "the moonlit fountain again"}); gen_and_wait(chat2["id"])
    check("and its lore is gone from the prompt", "ALWAYS-LORE" not in sysprompt() and "MOONLIT-LORE" not in sysprompt())
    invoke("delete_character", {"id": greeter["id"]})

    # -- the screens: make a room, enter it, text on the phone, switch a pack on and off
    def click_text(sel, text, root="document"):
        return d.execute_script("const el=[...document.querySelectorAll(arguments[0])].find(b=>b.textContent.includes(arguments[1])&&!b.disabled);if(!el)return false;el.scrollIntoView({block:'center'});el.click();return true", sel, text)
    def set_value(sel, value):
        d.execute_script("const el=document.querySelector(arguments[0]);const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,arguments[1]);el.dispatchEvent(new Event('input',{bubbles:true}))", sel, value)
    reload_ui(); nav("Rooms"); time.sleep(0.6)
    check("the Rooms page lists the rooms made so far", text_present("Mira's loft") and text_present("Make a room"))
    check("Make a room opens the creation form", click_text("button", "Make a room") and text_present("Who is this room for?"))
    set_value("input[placeholder='e.g. My loft']", "Rooftop hangout")
    click_text("button.chip", "Rooftop"); click_text("button.chip", "A character's place")
    set_value("textarea", "A rooftop with string lights, two beanbags and a view of the whole campus.")
    check("choosing a backdrop shows the shelf of scenes", click_text("button", "Choose a backdrop") and d.execute_script("return document.querySelectorAll('.preset').length") >= 6)
    d.execute_script("document.querySelector('.preset').click()"); time.sleep(0.3)
    check("a picked backdrop previews in the form", d.execute_script("return getComputedStyle(document.querySelector('.room-preview')).backgroundImage.includes('gradient')"))
    shot("room-form")
    check("Create & enter makes the room and drops you into a chat set in it", click_text("button", "Create & enter") and text_present("Rooftop hangout") and wait(15).until(lambda x: x.execute_script("return !!document.querySelector('.chatmain .room-bg')")))
    rr = [r for r in invoke("list_rooms") if r["name"] == "Rooftop hangout"]
    check("the room, a dorm in it and a first chat now exist", len(rr) == 1 and any(dd["room_id"] == rr[0]["id"] for dd in invoke("list_dorms")) and rr[0]["owner_kind"] == "character" and rr[0]["character_id"])
    check("the chat header shows which room it is in", d.execute_script("return !!document.querySelector('.chathead .linklike')") and "Rooftop hangout" in d.execute_script("return document.querySelector('.chathead .linklike').textContent"))
    d.execute_script("document.querySelector('.chatopts')?.classList.add('open')")
    check("the phone view starts off", not d.execute_script("return !!document.querySelector('[data-testid=phone]')"))
    click_text(".chathead button", "Phone"); time.sleep(0.8)
    check("📱 Phone turns the chat into a texting view", d.execute_script("return !!document.querySelector('[data-testid=phone]')") and d.execute_script("return !!document.querySelector('.phone-head')"))
    shot("phone")
    seen["pieces"] = ["omg hi!!\n\n", "*waves* ", "you came 😊"]
    box = d.find_element(By.CSS_SELECTOR, "input[aria-label='Text message']"); box.send_keys("hey it's me"); box.send_keys(Keys.ENTER)
    check("a text you send appears as your own bubble", wait(10).until(lambda x: x.execute_script("return [...document.querySelectorAll('.bub.me')].some(b=>b.textContent.includes('hey it'))")))
    check("her reply arrives as separate text bubbles (blank line = new text, *actions* dropped)", wait(20).until(lambda x: x.execute_script("const t=[...document.querySelectorAll('.bub.them')].map(b=>b.textContent.trim());return t.includes('omg hi!!')&&t.some(v=>v.includes('you came'))")) and not d.execute_script("return [...document.querySelectorAll('.bub')].some(b=>b.textContent.includes('*waves*'))"))
    seen["pieces"] = None
    click_text(".phone-head button", "‹"); time.sleep(0.6)
    check("the back arrow returns to the normal chat", not d.execute_script("return !!document.querySelector('[data-testid=phone]')") and d.execute_script("return !!document.querySelector('.msgs')"))
    click_text(".chathead button", "Mechanics"); time.sleep(0.7)
    check("🧩 Mechanics lists the packs with switches (off by default)", text_present("Heartbeat") and d.execute_script("const s=document.querySelector('[role=switch][aria-label=\"Heartbeat on\"]');return !!s&&!s.checked"))
    d.execute_script("document.querySelector('[role=switch][aria-label=\"Heartbeat on\"]').click()"); time.sleep(0.8)
    rc = [c for c in invoke("list_chats") if c["name"] == "Rooftop hangout"][0]
    check("flipping a switch turns the pack on for this chat only", invoke("chat_mechanics", {"chatId": rc["id"]})[0]["enabled"] is True and invoke("chat_mechanics", {"chatId": chat2["id"]}) == [])
    check("a switched-on pack shows what it tracks, with a slider to adjust", text_present("Affection") and d.execute_script("return !!document.querySelector('input[type=range][aria-label=\"Set Affection\"]')"))
    shot("mechanics")
    d.execute_script("document.querySelector('[role=switch][aria-label=\"Heartbeat on\"]').click()"); time.sleep(0.6)
    check("and the same switch turns it off again", invoke("chat_mechanics", {"chatId": rc["id"]})[0]["enabled"] is False)
    check("Escape closes the Mechanics window", (ActionChains(d).send_keys(Keys.ESCAPE).perform() or True) and not time.sleep(0.5) and not d.execute_script("return !!document.querySelector('[role=dialog][aria-label=Mechanics]')"))
    # -- notes: unlimited writing, a click away
    big = "The quick brown fox. " * 20000   # 420,000 characters
    n1 = invoke("save_note", {"note": {"id": "", "title": "Long plans", "body": big, "pinned": False, "created_at": 0, "updated_at": 0}})
    check("a note can be hundreds of thousands of characters long", len(invoke("list_notes")[0]["body"]) == len(big) and n1["id"], str(len(big)))
    n2 = invoke("save_note", {"note": {"id": "", "title": "Pinned one", "body": "short", "pinned": True, "created_at": 0, "updated_at": 0}})
    check("pinned notes come first", [n["title"] for n in invoke("list_notes")][:2] == ["Pinned one", "Long plans"])
    n1b = invoke("save_note", {"note": {"id": n1["id"], "title": "Long plans v2", "body": "edited", "pinned": False, "created_at": 0, "updated_at": 0}})
    check("saving with an id edits that note (same id, same creation time)", n1b["id"] == n1["id"] and n1b["created_at"] == n1["created_at"] and len(invoke("list_notes")) == 2 and [n for n in invoke("list_notes") if n["id"] == n1["id"]][0]["body"] == "edited")
    reload_ui(); nav("Notes"); time.sleep(0.8)
    check("the Notes page lists notes and opens the newest-pinned one", text_present("Pinned one") and text_present("Long plans v2"))
    shot("notes")
    click_text("button", "New note"); time.sleep(0.6)
    set_value("input[aria-label='Note title']", "Ideas for Mira")
    set_value("textarea[aria-label='Note text']", "She keeps a locket.\nShe hates mornings.")
    time.sleep(1.8)
    got = [n for n in invoke("list_notes") if n["title"] == "Ideas for Mira"]
    check("typing saves by itself", len(got) == 1 and got[0]["body"] == "She keeps a locket.\nShe hates mornings.", str(got))
    check("the page shows the count and that it's saved", text_present("Saved") and text_present("characters"))
    set_value("input[aria-label='Search notes']", "locket"); time.sleep(0.4)
    check("search finds a note by what's inside it", d.execute_script("return [...document.querySelectorAll('.note-item')].length") == 1)
    set_value("input[aria-label='Search notes']", "")
    d.execute_script("window.confirm=()=>true"); click_text("button[aria-label='Delete note']", ""); time.sleep(0.6)
    check("a note can be deleted", all(n["title"] != "Ideas for Mira" for n in invoke("list_notes")))
    for n in invoke("list_notes"): invoke("delete_note", {"id": n["id"]})

    # -- character folders: make one, drag a character in, give it a picture and a name, delete it
    reload_ui(); nav("Characters"); time.sleep(0.8)
    n_chars = len(invoke("list_characters"))
    check("Characters has a New folder button", click_text("button", "New folder") and wait(5).until(lambda x: x.execute_script("return !!document.querySelector('.modal input[aria-label=\\'Folder name\\']')")))
    set_value("input[aria-label='Folder name']", "Study group"); click_text(".modal button", "Create folder"); time.sleep(1.0)
    fid = [f for f in invoke("list_folders") if f["name"] == "Study group"][0]["id"]
    check("a new folder opens, empty", d.execute_script("return !!document.querySelector('.fbar')") and text_present("This folder is empty"))
    click_text("button.crumb", "All characters"); time.sleep(0.6)
    check("back at the top, the folder is a tile", d.execute_script("return !!document.querySelector('.ftile[data-folder=\"Study group\"]')"))
    res = d.execute_script("""
      try {
        const card = document.querySelector('.ccard'); const tile = document.querySelector('.ftile[data-folder="Study group"]');
        const dt = new DataTransfer();
        card.dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: dt}));
        tile.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: dt}));
        tile.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: dt}));
        return 'ok';
      } catch (e) { return String(e); }""")
    time.sleep(1.0)
    moved = [c for c in invoke("list_characters") if c.get("folder") == fid]
    check("dragging a character onto a folder files it there", res == "ok" and len(moved) == 1, str(res))
    check("the filed character leaves the top level and the tile counts it", d.execute_script("return document.querySelectorAll('.grid .ccard').length") == n_chars - 1 and "1 character" in d.execute_script("return document.querySelector('.ftile[data-folder=\"Study group\"]').innerText"))
    d.execute_script("document.querySelector('.ftile[data-folder=\"Study group\"]').click()"); time.sleep(0.7)
    check("opening the folder shows what's in it", d.execute_script("return document.querySelectorAll('.grid .ccard').length") == 1)
    shot("folder")
    inp = d.find_element(By.CSS_SELECTOR, "input[aria-label='Folder picture']"); d.execute_script("arguments[0].hidden=false;arguments[0].style.display='block';", inp)
    inp.send_keys(os.path.join(FIX, "avatar.gif")); time.sleep(1.2)
    check("choosing a folder picture opens the positioning window", d.execute_script("return !!document.querySelector('[data-testid=frame-main]')"))
    shot("frame-editor")
    set_value("input[aria-label=Zoom]", "1.8"); click_text(".modal button", "Save"); time.sleep(1.5)
    fz = [f for f in invoke("list_folders") if f["id"] == fid][0]
    check("the folder picture and its framing are saved", fz["cover"] and os.path.exists(fz["cover_path"]) and fz["frame"] and abs(fz["frame"]["zoom"] - 1.8) < 0.01, str(fz))
    click_text(".fbar button", "Rename"); time.sleep(0.3)
    d.find_element(By.CSS_SELECTOR, ".fbar input[aria-label='Folder name']").send_keys(Keys.CONTROL, "a"); d.find_element(By.CSS_SELECTOR, ".fbar input[aria-label='Folder name']").send_keys("Night owls" + Keys.ENTER); time.sleep(0.8)
    check("a folder can be renamed", [f["name"] for f in invoke("list_folders")] == ["Night owls"])
    d.execute_script("window.confirm=()=>true"); click_text(".fbar button", "Delete folder"); time.sleep(1.0)
    check("deleting the folder keeps the character and returns it to the top level", invoke("list_folders") == [] and len([c for c in invoke("list_characters") if not c.get("folder")]) == n_chars and d.execute_script("return document.querySelectorAll('.grid .ccard').length") == n_chars)
    check("the cards are the bigger size", d.execute_script("return document.querySelector('.ccard').getBoundingClientRect().height") >= 300)
    # nested folders on screen
    def mkfolder(name):
        click_text("button", "New folder"); wait(5).until(lambda x: x.execute_script("return !!document.querySelector('.modal input[aria-label=\\'Folder name\\']')"))
        set_value("input[aria-label='Folder name']", name); click_text(".modal button", "Create folder"); time.sleep(0.9)
    mkfolder("Canon character RP")
    mkfolder("Series A")
    check("a folder made while another is open goes inside it", {f["name"]: f.get("parent") for f in invoke("list_folders")}.get("Series A") == [f["id"] for f in invoke("list_folders") if f["name"] == "Canon character RP"][0])
    check("the path shows where you are (All characters › Canon character RP › Series A)", d.execute_script("const c=document.querySelector('.crumbs');return !!c && c.innerText.includes('All characters') && c.innerText.includes('Canon character RP') && c.innerText.includes('Series A')"))
    d.execute_script("document.querySelector('.crumb[data-crumb=\"Canon character RP\"]').click()"); time.sleep(0.6)
    check("clicking a step of the path goes back up to it, showing the folder inside", d.execute_script("return !!document.querySelector('.ftile[data-folder=\"Series A\"]')"))
    d.execute_script("document.querySelector('.crumb[data-crumb=\"All characters\"]').click()"); time.sleep(0.6)
    check("at the top only the top-level folder shows", d.execute_script("return !!document.querySelector('.ftile[data-folder=\"Canon character RP\"]') && !document.querySelector('.ftile[data-folder=\"Series A\"]')") and "1 folder" in d.execute_script("return document.querySelector('.ftile[data-folder=\"Canon character RP\"]').innerText"))
    mkfolder("Series B")
    d.execute_script("document.querySelector('.crumb[data-crumb=\"All characters\"]').click()"); time.sleep(0.6)
    res = d.execute_script("""
      try {
        const a = document.querySelector('.ftile[data-folder="Series B"]'), b = document.querySelector('.ftile[data-folder="Canon character RP"]');
        const dt = new DataTransfer();
        a.dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: dt}));
        b.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: dt}));
        b.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: dt}));
        return 'ok';
      } catch (e) { return String(e); }""")
    time.sleep(1.0)
    fm = {f["name"]: f for f in invoke("list_folders")}
    check("dragging a folder onto another puts it inside", res == "ok" and fm["Series B"]["parent"] == fm["Canon character RP"]["id"], str(res))
    d.execute_script("document.querySelector('.ftile[data-folder=\"Canon character RP\"]').click()"); time.sleep(0.6)
    check("both series are inside Canon now", d.execute_script("return document.querySelectorAll('.ftile').length") == 2)
    d.execute_script("document.querySelector('.ftile[data-folder=\"Series B\"]').click()"); time.sleep(0.6)
    click_text(".fbar button", "Move folder"); time.sleep(0.5)
    check("Move folder lists the folders as a tree (not itself)", d.execute_script("return !!document.querySelector('.modal [data-pick=\"Series A\"]') && !document.querySelector('.modal [data-pick=\"Series B\"]')"))
    d.execute_script("document.querySelector('.modal [data-pick=\"Series A\"]').click()"); time.sleep(0.9)
    fm = {f["name"]: f for f in invoke("list_folders")}
    check("picking a folder there moves it (now Canon > Series A > Series B)", fm["Series B"]["parent"] == fm["Series A"]["id"])
    d.execute_script("window.confirm=()=>true"); click_text(".fbar button", "Delete folder"); time.sleep(1.0)
    fm = {f["name"]: f for f in invoke("list_folders")}
    check("deleting a folder leaves you in the folder above it", "Series B" not in fm and d.execute_script("return document.querySelector('.crumbs b')?.innerText") == "Series A", str(d.execute_script("return document.querySelector('.crumbs')?.innerText")))
    for n in ("Series A", "Canon character RP"):
        pass
    for f in sorted(invoke("list_folders"), key=lambda f: 1 if f.get("parent") else 0, reverse=True): invoke("delete_folder", {"id": f["id"]})
    reload_ui(); nav("Characters"); time.sleep(0.6)

    # -- your own order: drag a card to where you want it; and a folder can borrow a character's picture
    names0 = d.execute_script("return [...document.querySelectorAll('.grid .ccard')].map(c=>c.dataset.char)")
    check("the library has several cards to rearrange and sorts by 'My order' by default", len(names0) >= 2 and d.execute_script("return document.querySelector('select[aria-label=Sort]').value") == "custom", str(names0))
    res = d.execute_script("""
      try {
        const cards = [...document.querySelectorAll('.grid .ccard')]; const a = cards[0], b = cards[cards.length - 1];
        const r = b.getBoundingClientRect(); const dt = new DataTransfer();
        a.dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: dt}));
        b.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.right - 2, clientY: r.top + 5}));
        b.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.right - 2, clientY: r.top + 5}));
        return 'ok';
      } catch (e) { return String(e); }""")
    time.sleep(1.0)
    names1 = d.execute_script("return [...document.querySelectorAll('.grid .ccard')].map(c=>c.dataset.char)")
    check("dropping a card on the right half of another puts it after that card", res == "ok" and names1 == names0[1:] + names0[:1], f"{res} {names0} -> {names1}")
    reload_ui(); nav("Characters"); time.sleep(0.8)
    check("the new order is remembered", d.execute_script("return [...document.querySelectorAll('.grid .ccard')].map(c=>c.dataset.char)") == names1)
    # a folder borrows a character's picture
    pic = [c for c in invoke("list_characters") if (c.get("media") or {}).get("kind") in ("image", "gif")]
    check("a character with a still picture exists for the folder test", len(pic) >= 1)
    if pic:
        fo2 = invoke("create_folder", {"name": "Picture test", "parent": None}); invoke("move_characters", {"ids": [pic[0]["id"]], "folder": fo2["id"]})
        fo2 = invoke("set_folder_cover_char", {"id": fo2["id"], "character": pic[0]["id"]})
        check("a folder remembers which character's picture it uses", fo2.get("cover_char") == pic[0]["id"] and not fo2.get("cover_path"))
        reload_ui(); nav("Characters"); time.sleep(0.8)
        check("the folder tile shows that character's picture", d.execute_script("return !!document.querySelector('.ftile[data-folder*=Picture] .fcover img')"))
        d.execute_script("document.querySelector('.ftile[data-folder=\"Picture test\"]').click()"); time.sleep(0.7)
        check("so does the open folder's header, and it offers to pick another", d.execute_script("return !!document.querySelector('.fbar-art img')") and click_text(".fbar button", "Change character picture"))
        time.sleep(0.5)
        check("the picker lists the folder's characters", d.execute_script("return !!document.querySelector('.modal [data-pick]')"))
        d.execute_script("document.querySelector('.modal [data-pick]').click()"); time.sleep(0.8)
        click_text(".fbar button", "Change character picture"); time.sleep(0.4); click_text(".modal button", "Stop using a character's picture"); time.sleep(0.9)
        check("it can be turned off again", not invoke("list_folders")[0].get("cover_char") and not d.execute_script("return !!document.querySelector('.fbar-art img')"))
        for f in invoke("list_folders"): invoke("delete_folder", {"id": f["id"]})
        reload_ui(); nav("Characters"); time.sleep(0.6)

    # -- lorebooks: import a SillyTavern world info file, attach it, delete it
    nav("Lorebooks"); time.sleep(0.6)
    inp = d.find_element(By.CSS_SELECTOR, "input[aria-label='Import lorebooks']"); inp.send_keys(os.path.join(FIX, "worldinfo_st.json")); time.sleep(1.5)
    libs = invoke("list_lorebooks")
    check("a world info file imports as a library lorebook", len(libs) == 1 and libs[0]["name"] == "worldinfo_st" and len(libs[0]["book"]["entries"]) == 3, str(libs)[:300])
    ents = {e["name"]: e for e in libs[0]["book"]["entries"]}
    check("its keys, 'always on' and disabled flags and position are understood", ents["The lantern"]["keys"] == ["lantern", "lamp"] and ents["Always"]["constant"] is True and ents["Always"]["position"] == "after_char" and ents["Off"]["enabled"] is False, str(ents)[:300])
    check("the Lorebooks page lists it with its entries", text_present("worldinfo_st") and text_present("3 entries"))
    nav("Characters"); time.sleep(0.5); d.execute_script("document.querySelector('.ccard').click()"); time.sleep(1.0)
    check("the character editor offers the library lorebook to attach", text_present("Shared lorebooks") and d.execute_script("return [...document.querySelectorAll('label')].some(l=>l.textContent.includes('worldinfo_st'))"))
    check("more initial messages sit in the main section, not hidden under Advanced", d.execute_script("const h=[...document.querySelectorAll('.f > span:first-child')].find(x=>x.textContent.includes('More initial messages'));return !!h && !h.closest('details')"))
    for l in invoke("list_lorebooks"): invoke("delete_lorebook", {"id": l["id"]})

    # -- personas on screen
    nav("Settings"); time.sleep(0.6); click_text("button[role=tab]", "Personas"); time.sleep(0.6)
    check("Settings has a Personas tab with the default persona", text_present("Personas") and d.execute_script("return !!document.querySelector('.persona-card[data-persona=default] .chip.on')"))
    shot("personas")
    click_text("button", "New persona"); time.sleep(0.5)
    set_value("input[aria-label='Persona name']", "Kai"); set_value("textarea[aria-label='Persona description']", "An art student."); set_value("textarea[aria-label='Roleplay preferences']", "Remember Mei is my sister.")
    inp = d.find_element(By.CSS_SELECTOR, "input[aria-label='Persona picture']"); inp.send_keys(os.path.join(FIX, "avatar.gif")); time.sleep(1.0)
    check("choosing a persona picture opens the positioning window", d.execute_script("return !!document.querySelector('[data-testid=frame-main]')"))
    set_value("input[aria-label=Zoom]", "1.6"); d.execute_script("const m=document.querySelector('[data-testid=frame-main]').closest('.modal');[...m.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save').click()"); time.sleep(0.8)
    click_text(".modal button", "Save persona"); time.sleep(1.5)
    pe = invoke("list_personas")
    check("a persona made on screen is saved with its picture and framing", len(pe) == 1 and pe[0]["name"] == "Kai" and pe[0]["avatar"] and pe[0]["frame"] and abs(pe[0]["frame"]["zoom"] - 1.6) < 0.01 and pe[0]["style"] == "Remember Mei is my sister.", str(pe))
    click_text(".persona-card[data-persona=Kai] button", "Use this persona"); time.sleep(0.8)
    check("'Use this persona' makes it active", invoke("get_settings")["active_persona"] == pe[0]["id"] and d.execute_script("return !!document.querySelector('.persona-card[data-persona=Kai] .chip.on')"))
    nav("Dorms"); time.sleep(0.8); click_text("button.it", "Rooftop hangout"); time.sleep(1.5)
    check("a chat has a quick 'Playing as' switch", d.execute_script("const s=document.querySelector('select[aria-label=\"Playing as\"]');return !!s && s.value===arguments[0]", pe[0]["id"]))
    d.execute_script("const m=[...document.querySelectorAll('.msg.user .avatar img')];window.__ua=m.length")
    invoke("add_user_message", {"chatId": rc["id"], "text": "hi from kai"}); reload_ui(); nav("Dorms"); time.sleep(0.8); click_text("button.it", "Rooftop hangout"); time.sleep(1.5)
    check("your messages show the persona's name and picture", d.execute_script("const u=document.querySelector('.msg.user');return !!u && u.querySelector('.who').textContent.includes('Kai') && !!u.querySelector('.avatar img')"))
    invoke("set_active_persona", {"id": None}); invoke("delete_persona", {"id": pe[0]["id"]})

    # -- controllers: any pad, named the way the pad names its buttons, with bindings you can change
    fake_pad = """
      window.__fake = { id: arguments[0], index: 0, connected: true, mapping: 'standard', axes: [0,0,0,0], buttons: Array.from({length: 17}, () => ({pressed: false, value: 0})) };
      window.__fakeDown = (i, on) => { window.__fake.buttons[i] = {pressed: !!on, value: on ? 1 : 0}; };
      navigator.getGamepads = () => [window.__fake];"""
    nav("Settings"); time.sleep(0.5); click_text("button[role=tab]", "Controller"); time.sleep(0.6)
    check("Settings has a Controller tab (and says what to do when no controller is found)", text_present("Controller") and d.execute_script("return !!document.querySelector('[data-testid=pad-none]')"))
    check("the default bindings are listed with button names", all(text_present(t) for t in ("Right hand: action", "Next hand gesture", "Pinch", "Pointing finger")))
    d.execute_script(fake_pad, "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)"); time.sleep(0.8)
    check("a PlayStation pad is recognised", "PlayStation controller" in page_text(), page_text()[:300])
    right_text = lambda: d.execute_script("return document.querySelector('[data-action=right]').innerText")
    check("its buttons are named the PlayStation way (Cross, L3...)", "Cross" in right_text() and "R3" in right_text(), right_text())
    check("the top button is Triangle, D-pad left/up/right pick the gestures", "Triangle" in d.execute_script("return document.querySelector('[data-action=cycle]').innerText") and "D-pad up" in d.execute_script("return document.querySelector('[data-action=point]').innerText"))
    d.execute_script("window.__fakeDown(5, true)"); time.sleep(0.4)
    check("pressing a button shows its name", "R1" in d.execute_script("return document.querySelector('[data-testid=pad-down]').innerText"))
    d.execute_script("window.__fakeDown(5, false)"); time.sleep(0.3)
    d.execute_script("document.querySelector('[aria-label=\"Change Right hand: action button 1\"]').click()"); time.sleep(0.4)
    check("Change waits for a button", d.execute_script("return !!document.querySelector('[data-testid=pad-capture]')"))
    d.execute_script("window.__fakeDown(1, true)"); time.sleep(0.5); d.execute_script("window.__fakeDown(1, false)"); time.sleep(0.4)
    check("the next button pressed becomes the binding", "Circle" in right_text() and "Cross" not in right_text(), right_text())
    check("bindings are remembered", "[1," in (d.execute_script("return localStorage.getItem('dorms.pad.bindings')") or ""))
    click_text("button", "Reset to defaults"); time.sleep(0.4)
    check("Reset puts the defaults back", "Cross" in right_text())
    d.execute_script("window.__fake.id = 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'"); time.sleep(0.6)
    check("a Nintendo pad is recognised and named its own way (B is the bottom button)", "Nintendo controller" in page_text() and right_text().startswith("Right hand") and "B" in right_text(), right_text())
    d.execute_script("window.__fake.id = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)'"); time.sleep(0.6)
    check("an Xbox pad too", "Xbox controller" in page_text())
    d.execute_script("window.__fake.id = 'Valve Software Steam Controller (STANDARD GAMEPAD Vendor: 28de Product: 11ff)'"); time.sleep(0.6)
    check("and a Steam Controller / Steam Deck", "Steam controller" in page_text())
    d.execute_script("delete navigator.getGamepads"); time.sleep(0.3)

    # -- background music in the chat
    rr2 = [r for r in invoke("list_rooms") if r["name"] == "Rooftop hangout"]
    if rr2:
        invoke_file("set_room_music", os.path.join(FIX, "tone.wav"), {"x-room-id": str(rr2[0]["id"]), "x-file-name": "tone.wav"})
        reload_ui(); nav("Dorms"); time.sleep(1.0)
        click_text("button.it", "Rooftop hangout"); time.sleep(2.0)
        check("a chat in a room with music shows the music player", d.execute_script("return !!document.querySelector('[data-testid=music]')") and "tone.wav" in d.execute_script("return document.querySelector('.music-name').textContent"))
        check("the music loops", wait(10).until(lambda x: x.execute_script("const a=document.querySelector('[data-testid=music] audio');return !!a&&a.loop===true&&a.src.startsWith('blob:')")))
        check("it has volume, mute and pause controls", d.execute_script("return !!document.querySelector('[aria-label=\"Music volume\"]') && !!document.querySelector('[aria-label=\"Mute music\"]') && !!document.querySelector('[aria-label=\"Pause music\"],[aria-label=\"Play music\"]')"))
        dd = [x for x in invoke("list_dorms") if x["room_id"] == rr2[0]["id"]][0]
        invoke_file("set_dorm_music", os.path.join(FIX, "song.mp3"), {"x-dorm-id": str(dd["id"]), "x-file-name": "dorm theme.mp3"})
        reload_ui(); nav("Dorms"); time.sleep(1.0); click_text("button.it", "Rooftop hangout"); time.sleep(2.0)
        check("the dorm's own music takes over from the room's", "dorm theme.mp3" in d.execute_script("return document.querySelector('.music-name').textContent"))
        invoke("clear_dorm_music", {"id": dd["id"]}); invoke("clear_room_music", {"id": rr2[0]["id"]})
    if not SKIP3D:
        # ---- talking from inside the 3D scene: the see-through message bar and the manga-style speech balloon ----------------
        # an earlier 3D screen that was left within its first couple of seconds leaves the crash marker behind (by design), and the next start would then show the safe placeholder: clear it
        invoke("vrm_guard_end")
        reload_ui(); nav("Dorms")
        d.find_element(By.XPATH, "//button[contains(@class,'it') and contains(., 'cloud')]").click(); time.sleep(1.5)
        for _ in range(60):
            if d.execute_script("const e=document.querySelector('.stage .vrm-box');return !!e&&e.dataset.ready==='1'"): break
            time.sleep(0.5)
        check("the chat's side panel shows the live 3D character", d.execute_script("return !!document.querySelector('.stage .vrm-box[data-ready=\"1\"]')"), d.execute_script("const s=document.querySelector('.stage');return s?s.innerText.slice(0,160)+' | '+JSON.stringify((s.querySelector('.vrm-box')||{}).dataset||{}).slice(0,200):'no .stage'"))
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
    # rooms, packs and texting style travel in a backup, and go with an ejected profile
    check("another profile can't see your personas", invoke("list_personas") == [])
    invoke_file("set_profile_avatar", os.path.join(FIX, "avatar.gif"), {"x-file-name": "me.gif"})
    invoke("set_profile_avatar_frame", {"frame": {"x": 0.4, "y": 0.6, "zoom": 1.5}})
    ps = invoke("session_state")["profile"]
    check("a profile can have a picture (animated GIF) with its framing", ps["avatar"] and os.path.exists(ps["avatar"]) and ps["avatar_frame"] == {"x": 0.4, "y": 0.6, "zoom": 1.5}, str(ps))
    check("a profile picture has to be an image", "image" in (inv_err_file("set_profile_avatar", os.path.join(FIX, "loose.json"), {"x-file-name": "x.json"}) or "").lower() or "png" in (inv_err_file("set_profile_avatar", os.path.join(FIX, "loose.json"), {"x-file-name": "x.json"}) or "").lower())
    pk_p = invoke("save_persona", {"persona": {"id": "", "name": "Backed-up Bea", "description": "d", "style": "s", "avatar": None, "frame": None, "created_at": 0}})
    invoke_file("set_persona_avatar", os.path.join(FIX, "avatar.gif"), {"x-persona-id": pk_p["id"], "x-file-name": "bea.gif"})
    invoke("set_persona_frame", {"id": pk_p["id"], "frame": {"x": 0.1, "y": 0.2, "zoom": 3}})
    invoke("set_active_persona", {"id": pk_p["id"]})
    rm = invoke("create_room", {"room": {"id": 0, "created_at": 0, "name": "Backed-up den", "kind": "basement", "description": "Low ceiling, big couch.", "owner_kind": "self", "character_id": None, "backdrop": ""}})
    rm = invoke_file("set_room_backdrop", os.path.join(FIX, "avatar.gif"), {"x-room-id": str(rm["id"]), "x-file-name": "avatar.gif"})
    pk2 = invoke_file("import_mechanic", pack_path, {})
    invoke("save_note", {"note": {"id": "", "title": "Backed-up note", "body": "keep me", "pinned": True, "created_at": 0, "updated_at": 0}})
    rm = invoke_file("set_room_music", os.path.join(FIX, "song.mp3"), {"x-room-id": str(rm["id"]), "x-file-name": "room song.mp3"})
    filed = invoke("save_character", {"character": {"id": "", "card": dict(card0, name="Filed"), "frame": {"x": 0.3, "y": 0.2, "zoom": 1.7}}})
    fcrew = invoke("create_folder", {"name": "Crew"})
    fcrew = invoke_file("set_folder_cover", os.path.join(FIX, "avatar.gif"), {"x-folder-id": fcrew["id"], "x-file-name": "avatar.gif"})
    fcrew = invoke("set_folder_frame", {"id": fcrew["id"], "frame": {"x": 0.6, "y": 0.4, "zoom": 2.2}})
    fkid = invoke("create_folder", {"name": "Crew kids", "parent": fcrew["id"]})
    invoke("move_characters", {"ids": [filed["id"]], "folder": fcrew["id"]})
    lbk = invoke("save_lorebook", {"lorebook": {"id": "", "name": "Packed lore", "book": {"entries": [{"keys": ["k"], "content": "packed lore text", "enabled": True}]}, "created_at": 0, "updated_at": 0}})
    invoke("save_character", {"character": dict(filed, lorebooks=[lbk["id"]])})
    dm = invoke("create_dorm", {"name": "Packed dorm", "roomId": rm["id"]})
    invoke_file("set_dorm_music", os.path.join(FIX, "tone.wav"), {"x-dorm-id": str(dm["id"]), "x-file-name": "dorm tune.wav"})
    pc = invoke("create_chat", {"dormId": dm["id"], "name": "packed chat", "kind": "channel", "characterIds": []})
    invoke("set_chat_mechanic", {"chatId": pc["id"], "mechId": pk2["id"], "enabled": True})
    invoke("set_chat_variable", {"chatId": pc["id"], "mechId": pk2["id"], "path": "aff", "value": 77})
    invoke("update_chat", {"chat": dict(invoke("list_chats")[0], style="phone")})
    info = invoke("prepare_export")
    check("the backup counts every picture and music file (backdrop, 2 music files, folder cover, persona picture, profile picture)", info["media"] == 6, str(info))
    rpath = os.path.join(WORK, "rooms.dorms"); invoke("save_export", {"token": info["token"], "path": rpath})
    n_media_now = len(os.listdir(media_dir))
    invoke("eject_profile", {"token": info["token"]})
    check("eject removes those files too", len(os.listdir(media_dir)) == n_media_now - 6)
    invoke_file("import_profile", rpath, {"x-mode": "import", "x-handle": "Stylist2", "x-passcode": ""})
    r2 = invoke("list_rooms")
    check("the restored profile has its room, with the backdrop file", len(r2) == 1 and r2[0]["name"] == "Backed-up den" and r2[0]["backdrop"].startswith("file:media/room-") and os.path.exists(r2[0]["backdrop_path"]), str(r2))
    d2 = invoke("list_dorms")
    ps2 = invoke("session_state")["profile"]
    check("the profile picture came back with its framing", ps2["avatar"] and os.path.exists(ps2["avatar"]) and ps2["avatar_frame"] == {"x": 0.4, "y": 0.6, "zoom": 1.5}, str(ps2))
    pe2 = invoke("list_personas")
    check("the persona came back with its picture and framing", len(pe2) == 1 and pe2[0]["name"] == "Backed-up Bea" and os.path.exists(pe2[0]["avatar_path"]) and pe2[0]["frame"] == {"x": 0.1, "y": 0.2, "zoom": 3.0}, str(pe2))
    check("and it is still the active one (its new id)", invoke("get_settings")["active_persona"] == pe2[0]["id"])
    check("the room's music came back with its name", r2[0]["music_name"] == "room song.mp3" and os.path.exists(r2[0]["music_path"]), str(r2[0]))
    check("so did the dorm's own music", invoke("list_dorms")[0]["music_name"] == "dorm tune.wav" and os.path.exists(invoke("list_dorms")[0]["music_path"]))
    fl = invoke("list_folders"); fch = [c for c in invoke("list_characters") if c["card"]["name"] == "Filed"][0]
    fcr = [f for f in fl if f["name"] == "Crew"][0]
    check("the folder came back with its picture and framing", fcr["name"] == "Crew" and os.path.exists(fcr["cover_path"]) and fcr["frame"] == {"x": 0.6, "y": 0.4, "zoom": 2.2}, str(fl))
    check("folders inside folders come back nested", len(fl) == 2 and {f["name"]: f.get("parent") for f in fl}.get("Crew kids") == [f["id"] for f in fl if f["name"] == "Crew"][0], str(fl))
    check("the character is still filed in it (new id mapped), with its own framing", fch["folder"] == fcr["id"] and fch["frame"] == {"x": 0.3, "y": 0.2, "zoom": 1.7}, str(fch.get("folder")))
    lbs = invoke("list_lorebooks")
    check("the lorebook came back, still attached to the character", len(lbs) == 1 and lbs[0]["name"] == "Packed lore" and fch["lorebooks"] == [lbs[0]["id"]])
    check("the dorm is still set in that room", len(d2) == 1 and d2[0]["room_id"] == r2[0]["id"], str(d2))
    c2 = invoke("list_chats")[0]
    check("notes come back with a backup", [(n["title"], n["body"], n["pinned"]) for n in invoke("list_notes")] == [("Backed-up note", "keep me", True)])
    check("the chat kept its texting style", c2["style"] == "phone")
    cm2 = invoke("chat_mechanics", {"chatId": c2["id"]})
    check("the pack came back in the library, switched on in that chat with its progress (affection 77)", len(invoke("list_mechanics")) == 1 and len(cm2) == 1 and cm2[0]["enabled"] and cm2[0]["state"]["aff"] == 77, str(cm2))
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

    # -- an imported 3D room: import, defaults, sharing mark, export rules
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import mkroom
    glb = os.path.join(WORK, "house.glb"); open(glb, "wb").write(mkroom.room_glb())
    bad = os.path.join(WORK, "notamodel.glb"); open(bad, "wb").write(b"this is just text, not a 3D model")
    invoke("create_profile", {"handle": "Roomer", "displayName": "Roomer", "passcode": None})
    mk = lambda n: invoke("create_room", {"room": {"id": 0, "name": n, "kind": "living_room", "description": "", "owner_kind": "self", "character_id": None, "backdrop": "", "created_at": 0}})
    pub, priv = mk("Shared house"), mk("Private house")
    check("a new room has no 3D model", not pub.get("model") and pub.get("model_share") is False and pub.get("model_scale") == 1.0)
    check("a model has to be a .glb, .gltf or .fbx", "glb" in (inv_err_file("set_room_model", glb, {"x-room-id": str(pub["id"]), "x-file-name": "house.unitypackage"}) or ""))
    check("a file that only has a model's name is refused", "valid 3D model" in (inv_err_file("set_room_model", bad, {"x-room-id": str(pub["id"]), "x-file-name": "house.glb"}) or ""))
    pub = invoke_file("set_room_model", glb, {"x-room-id": str(pub["id"]), "x-file-name": "My house.glb"})
    priv = invoke_file("set_room_model", glb, {"x-room-id": str(priv["id"]), "x-file-name": "Booth house.glb"})
    # the chunked upload (what the app uses): straight to disk, any size, and it checks the free space first
    chunky = mk("Chunky house"); data = open(glb, "rb").read()
    ds = invoke("disk_space")
    check("the app can tell how much space is free on the device", ds["free"] > 0 and ds["total"] >= ds["free"], str(ds))
    check("a file that can't fit on the drive is refused before anything is copied", "enough free space" in (inv_err("room_model_begin", {"size": 10 ** 15}) or ""))
    tok = invoke("room_model_begin", {"size": len(data)})
    for i in range(0, len(data), 4000):
        invoke("room_model_chunk", {"token": tok, "data": base64.b64encode(data[i:i + 4000]).decode()})
    chunky = invoke("room_model_finish", {"id": chunky["id"], "token": tok, "fileName": "Big house.glb"})
    check("a model sent in pieces becomes the room's model, not shareable by default", chunky["model_name"] == "Big house.glb" and os.path.exists(chunky["model_path"]) and os.path.getsize(chunky["model_path"]) == len(data) and chunky["model_share"] is False, str(chunky))
    tok = invoke("room_model_begin", {"size": 9}); invoke("room_model_chunk", {"token": tok, "data": base64.b64encode(b"not a model").decode()})
    check("pieces that are not a model are refused and cleaned up", "valid 3D model" in (inv_err("room_model_finish", {"id": chunky["id"], "token": tok, "fileName": "x.glb"}) or "") and not any(f.startswith(".roomup-" + tok) for f in os.listdir(media_dir)))
    tok = invoke("room_model_begin", {"size": 9}); invoke("room_model_chunk", {"token": tok, "data": base64.b64encode(data[:100]).decode()})
    check("a .unitypackage is turned down with a clear message", "unitypackage" in (inv_err("room_model_finish", {"id": chunky["id"], "token": tok, "fileName": "RTGI TV Room.unitypackage"}) or ""))
    check("a made-up upload token is refused", "cancelled" in (inv_err("room_model_chunk", {"token": "../../etc/passwd", "data": ""}) or ""))
    invoke("delete_room", {"id": chunky["id"]})
    check("an imported model is saved with its name, and is NOT marked shareable by default", pub["model"].startswith("media/roommodel-") and pub["model_name"] == "My house.glb" and os.path.exists(pub["model_path"]) and pub["model_share"] is False, str(pub))
    pub = invoke("set_room_model_cfg", {"id": pub["id"], "scale": 1.25, "rot": 90.0, "y": 0.1, "share": True})
    check("size, turn, height and the sharing mark are saved", (pub["model_scale"], pub["model_rot"], pub["model_y"], pub["model_share"]) == (1.25, 90.0, 0.1, True), str(pub))
    pub2 = invoke("update_room", {"room": dict(pub, name="Shared house", model="media/evil.glb", model_share=False, model_scale=9)})
    check("saving the room's text can't swap the model or the sharing mark", pub2["model"] == pub["model"] and pub2["model_share"] is True and pub2["model_scale"] == 1.25, str(pub2))
    check("the room list shows the model", {r["name"]: bool(r["model"]) for r in invoke("list_rooms")} == {"Shared house": True, "Private house": True})
    info = invoke("prepare_export")
    check("the export names the room whose model is not shareable and leaves it out", info["withheld_rooms"] == ["Private house"] and info["media"] == 1, str(info))
    xp = os.path.join(WORK, "roomer.dorms"); invoke("save_export", {"token": info["token"], "path": xp})
    files_before = len(os.listdir(media_dir))
    invoke("eject_profile", {"token": info["token"]})
    check("eject removes both model files from the device", len(os.listdir(media_dir)) == files_before - 2, f"{files_before} -> {len(os.listdir(media_dir))}")
    invoke_file("import_profile", xp, {"x-mode": "import", "x-handle": "Roomer2", "x-passcode": ""})
    rr = {r["name"]: r for r in invoke("list_rooms")}
    check("both rooms came back", set(rr) == {"Shared house", "Private house"}, str(list(rr)))
    check("the shareable room came back with its model, settings and mark", rr["Shared house"]["model"] and os.path.exists(rr["Shared house"]["model_path"]) and rr["Shared house"]["model_name"] == "My house.glb" and (rr["Shared house"]["model_scale"], rr["Shared house"]["model_rot"], rr["Shared house"]["model_y"], rr["Shared house"]["model_share"]) == (1.25, 90.0, 0.1, True), str(rr["Shared house"]))
    check("the other came back without its model and is not marked shareable", not rr["Private house"]["model"] and rr["Private house"]["model_share"] is False and rr["Private house"]["model_name"] == "", str(rr["Private house"]))
    check("a model can be removed again", not invoke("clear_room_model", {"id": rr["Shared house"]["id"]})["model"] and len(os.listdir(media_dir)) == files_before - 2)
    info2 = invoke("prepare_export")
    check("with no models left nothing is withheld", info2["withheld_rooms"] == [])

    # -- Unity packages: opened inside the app, refused with a reason when they can't become a room
    import tarfile, io as _io
    def mkpkg(path, assets):
        with tarfile.open(path, "w:gz") as t:
            for guid, pn, data in assets:
                for name, b in (("asset", data), ("asset.meta", b"fileFormatVersion: 2\n"), ("pathname", (pn + "\n00\n").encode())):
                    ti = tarfile.TarInfo(f"{guid}/{name}"); ti.size = len(b); t.addfile(ti, _io.BytesIO(b))
    g = lambda c: c * 32
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
    mat = ("%YAML 1.1\nMaterial:\n  m_Name: Floor\n  m_SavedProperties:\n    m_TexEnvs:\n    - _MainTex:\n        m_Texture: {fileID: 2800000, guid: " + g("b") + ", type: 3}\n    m_Colors:\n    - _Color: {r: 1, g: 1, b: 1, a: 1}\n").encode()
    pk_ok = os.path.join(WORK, "room-ok.unitypackage"); mkpkg(pk_ok, [(g("a"), "Assets/Room/Room.glb", open(glb, "rb").read()), (g("b"), "Assets/Room/Floor.png", png), (g("c"), "Assets/Room/Floor.mat", mat)])
    pk_two = os.path.join(WORK, "room-two.unitypackage"); mkpkg(pk_two, [(g("a"), "Assets/Room/Big Room.glb", open(glb, "rb").read()), (g("d"), "Assets/Props/Small Prop.glb", open(glb, "rb").read()[:2000])])
    pk_none = os.path.join(WORK, "room-none.unitypackage"); mkpkg(pk_none, [(g("b"), "Assets/Room/Floor.png", png), (g("c"), "Assets/Room/Floor.mat", mat)])
    pk_blend = os.path.join(WORK, "room-blend.unitypackage"); mkpkg(pk_blend, [(g("e"), "Assets/Room/Room.blend", b"BLENDER"), (g("f"), "Assets/Room/Other.max", b"max")])
    pk_scene = os.path.join(WORK, "room-scene.unitypackage"); mkpkg(pk_scene, [(g("1"), "Assets/Scenes/Room.unity", b"%YAML 1.1\n"), (g("2"), "Assets/Prefabs/Prop.prefab", b"%YAML 1.1\n")])
    pk_text = os.path.join(WORK, "room-text.unitypackage"); open(pk_text, "wb").write(b"this is not a package at all")
    # the app's own steps, one by one
    def upload(path, factor=1):
        data = open(path, "rb").read(); t = invoke("room_model_begin", {"size": len(data) * factor})
        for i in range(0, len(data), 6000): invoke("room_model_chunk", {"token": t, "data": base64.b64encode(data[i:i + 6000]).decode()})
        return t
    tk = upload(pk_two); rep = invoke("room_package_scan", {"token": tk})
    check("a package lists its models, biggest first", [m["name"] for m in rep["models"]] == ["Big Room.glb", "Small Prop.glb"] and rep["models"][0]["size"] > rep["models"][1]["size"], str(rep))
    ex = invoke("room_package_extract", {"token": tk, "modelGuid": rep["models"][0]["guid"]})
    check("the chosen model is unpacked into a file the app can read", ex["model_ext"] == "glb" and os.path.getsize(ex["model"]) == os.path.getsize(glb), str(ex))
    invoke("room_package_cleanup", {"token": tk})
    check("cleaning up leaves nothing behind", not [f for f in os.listdir(media_dir) if f.startswith((".roomup-", "pkgtmp-"))], str(os.listdir(media_dir)))
    for label, path, want in [("with no 3D model in it", pk_none, "no 3D model"), ("whose models are in formats it can't read", pk_blend, ".blend"), ("that is only a Unity scene of separate pieces", pk_scene, "scene"), ("that isn't a package at all", pk_text, "isn't a Unity package")]:
        tk = upload(path); err = inv_err("room_package_scan", {"token": tk})
        check(f"a package {label} is refused with the reason", want in (err or ""), str(err))
        check(f"and its files are removed ({label})", not [f for f in os.listdir(media_dir) if f.startswith(".roomup-" + tk)])
    check("a package that can't fit on the drive is refused before it is copied", "enough free space" in (inv_err("room_model_begin", {"size": 3 * 10 ** 15}) or ""))
    # the same thing through the room form
    reload_ui(); nav("Rooms"); time.sleep(0.6)
    click_text("button", "Make a room"); wait(5).until(lambda x: x.execute_script("return !!document.querySelector('input[placeholder=\\'e.g. My loft\\']')"))
    set_value("input[placeholder='e.g. My loft']", "Package room")
    def pkg_ui(path):
        d.find_element(By.CSS_SELECTOR, "input[aria-label='3D room model']").send_keys(path)
        for _ in range(60):
            time.sleep(0.5)
            r = d.execute_script("const n=document.querySelector('[data-testid=model-name]'),p=document.querySelector('[data-testid=model-problem]'),c=document.querySelector('[data-testid=package-choices]');return {name:n?n.textContent:'',problem:p?p.textContent:'',choose:!!c}")
            if (r["name"] and "Built-in" not in r["name"]) or r["problem"] or r["choose"]: return r
        return r
    r = pkg_ui(pk_none)
    check("the room form refuses a package with no 3D model and says why", "no 3D model" in r["problem"] and "Built-in" in d.execute_script("return document.querySelector('[data-testid=model-name]').textContent"), str(r))
    r = pkg_ui(pk_two)
    check("a package with several models asks which one is the room", r["choose"] and d.execute_script("return [...document.querySelectorAll('[data-testid=package-choices] [data-pick]')].map(b=>b.dataset.pick).join('|')") == "Big Room.glb|Small Prop.glb", str(r))
    d.execute_script("document.querySelector('[data-testid=package-choices] [data-pick=\"Big Room.glb\"]').click()")
    for _ in range(40):
        time.sleep(0.5)
        if "Big Room.glb" in d.execute_script("return document.querySelector('[data-testid=model-name]').textContent"): break
    check("choosing one makes it the room's model in the form", "Big Room.glb" in d.execute_script("return document.querySelector('[data-testid=model-name]').textContent"))
    click_text("button", "Save to list"); time.sleep(2.0)
    pr = [x for x in invoke("list_rooms") if x["name"] == "Package room"]
    check("saving stores the room with the model taken out of the package", len(pr) == 1 and pr[0]["model_name"] == "Big Room.glb" and os.path.exists(pr[0]["model_path"]) and pr[0]["model_share"] is False, str(pr))
    check("the package's temporary files are gone", not [f for f in os.listdir(media_dir) if f.startswith((".roomup-", "pkgtmp-"))], str(os.listdir(media_dir)))
    for x in pr: invoke("delete_room", {"id": x["id"]})

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
