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
from selenium.webdriver.support.ui import Select
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
           WEBKIT_DISABLE_COMPOSITING_MODE="1", WEBKIT_DISABLE_DMABUF_RENDERER="1", DORMS_NO_STARTERS="1", DORMS_TRANSFER_LOOPBACK="1")
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
def click_exact(sel, text):
    return d.execute_script("const el=[...document.querySelectorAll(arguments[0])].find(b=>b.textContent.trim()===arguments[1]&&!b.disabled);if(!el)return false;el.scrollIntoView({block:'center'});el.click();return true", sel, text)
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

    import base64 as _b64
    PNG_ = _b64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
    class Pic(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            if self.path.startswith("/cat.png"): body, ct = PNG_, "application/octet-stream"      # a wrong label: the first bytes decide
            elif self.path.startswith("/page"): body, ct = b"<!doctype html><html><body>not a picture</body></html>", "text/html"
            elif self.path.startswith("/redir"):
                self.send_response(302); self.send_header("Location", "/cat.png"); self.end_headers(); return
            else: self.send_response(404); self.end_headers(); return
            self.send_response(200); self.send_header("Content-Type", ct); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    picsrv = HTTPServer(("127.0.0.1", 18997), Pic); threading.Thread(target=picsrv.serve_forever, daemon=True).start()
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
            # a picture link does the same as an upload: it is fetched, positioned, then saved
            frame_before_ = invoke("get_character", {"id": mira["id"]}).get("frame")
            set_value("[data-testid=avatar-link]", "http://127.0.0.1:18997/cat.png"); time.sleep(0.3)
            d.find_element(By.CSS_SELECTOR, "[data-testid=avatar-link-use]").click(); time.sleep(2.0)
            check("using a picture link opens the same positioning window as an upload", d.execute_script("return !!document.querySelector('[data-testid=frame-main] img')"))
            click_text(".modal button", "Save"); time.sleep(2.2)
            check("and the picture from the link becomes the avatar", ((invoke("get_character", {"id": mira["id"]})["media"]) or {}).get("kind") == "image")
            set_media_ipc(mira["id"], os.path.join(FIX, fname))   # the GIF goes back, for what follows
            invoke("set_frame", {"id": mira["id"], "frame": frame_before_})   # and so does the framing that was chosen above
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
    # a moving (GIF) backdrop is made light: smaller, eight pictures a second at most, and it keeps a still picture
    check("a small GIF backdrop gets a still picture of its first frame", kit.get("backdrop_still_path") and os.path.exists(kit["backdrop_still_path"]) and kit["backdrop_still_path"].endswith("-still.png"), str(kit.get("backdrop_still_path")))
    import struct as _st
    _frames = []
    for _f in range(40):
        _im = Image.new("RGB", (1500, 800), (10 + _f * 5 % 200, 40, 90)); _frames.append(_im.convert("P", palette=Image.ADAPTIVE))
    _gp = os.path.join(WORK, "big-backdrop.gif"); _frames[0].save(_gp, "GIF", save_all=True, append_images=_frames[1:], duration=20, loop=0)
    big_room = invoke_file("set_room_backdrop", _gp, {"x-room-id": str(room["id"]), "x-file-name": "big-backdrop.gif"})
    _hdr = open(big_room["backdrop_path"], "rb").read(10); _w, _h = _st.unpack("<HH", _hdr[6:10])
    _still = Image.open(big_room["backdrop_still_path"])
    check("a big GIF backdrop is stored smaller (at most 854 across), keeping its shape", _w <= 854 and abs(_w / _h - 1500 / 800) < 0.05 and os.path.getsize(big_room["backdrop_path"]) < os.path.getsize(_gp), f"{_w}x{_h}")
    _g2 = Image.open(big_room["backdrop_path"]); _n = getattr(_g2, "n_frames", 1)
    check("and slower with fewer pictures (40 frames of 20 ms became a handful of 125 ms ones)", _n <= 8 and _g2.info.get("duration", 0) >= 100, f"{_n} frames, {_g2.info.get('duration')} ms")
    check("its still picture is a picture of the same size", _still.size == (_w, _h), str(_still.size))
    check("the old backdrop and its still picture are gone from disk", not any(f for f in os.listdir(os.path.dirname(big_room["backdrop_path"])) if f.startswith("room-%d-" % room["id"]) and os.path.join(os.path.dirname(big_room["backdrop_path"]), f) not in (big_room["backdrop_path"], big_room["backdrop_still_path"]) and f.endswith((".gif", "-still.png"))), str(os.listdir(os.path.dirname(big_room["backdrop_path"])))[:300])
    kit = big_room
    dorm_r = invoke("create_dorm", {"name": "Loft dorm", "roomId": room["id"]})
    check("a dorm can be set in a room", dorm_r["room_id"] == room["id"] and [x for x in invoke("list_dorms") if x["id"] == dorm_r["id"]][0]["room_id"] == room["id"])
    check("a dorm set in a room that doesn't exist just has none", invoke("create_dorm", {"name": "x", "roomId": 99999})["room_id"] is None)
    chat_r = invoke("create_chat", {"dormId": dorm_r["id"], "name": "loft chat", "kind": "dm", "characterIds": [mira["id"]]})
    invoke("add_user_message", {"chatId": chat_r["id"], "text": "hello there"}); gen_and_wait(chat_r["id"])
    check("the room's name, kind and description reach the system prompt", "Setting: Mira's loft" in sysprompt() and "a living room" in sysprompt() and "crooked window" in sysprompt() and "own place" in sysprompt(), sysprompt()[-400:])
    check("a chat outside any room gets no setting", "Setting:" not in (lambda: (gen_and_wait(chat2["id"]), sysprompt())[1])())

    # ---- pathways: rooms inside rooms, rooms joined to each other, and walking one chat from room to room ----
    mk_room = lambda name, desc, **kw: invoke("create_room", {"room": dict(room_in, name=name, description=desc, owner_kind="self", character_id=None, id=0, created_at=0, **kw)})
    house = mk_room("Our house", "A narrow blue house with a creaky porch.")
    kitchen = mk_room("Kitchen", "Yellow tiles and a very loud kettle.", parent_id=house["id"])
    livingr = mk_room("Living room", "A sagging sofa and a bookshelf.", parent_id=house["id"])
    garden = mk_room("Garden gate", "A gate in a mossy wall.")
    check("a room can be made part of another room", kitchen["parent_id"] == house["id"] and livingr["parent_id"] == house["id"] and house["parent_id"] is None, str(kitchen))
    house_b = invoke("update_room", {"room": dict(house, parent_id=kitchen["id"])})
    check("a room can't be put inside one of its own rooms", house_b["parent_id"] is None)
    garden = invoke("set_room_links", {"id": garden["id"], "links": [kitchen["id"], garden["id"], 99999, kitchen["id"]]})
    check("an exit leads to another of the owner's rooms (never to itself, to a room that isn't there, or twice)", garden["links"] == [kitchen["id"]], str(garden))
    check("an exit is one-way: the kitchen has none back yet", [r for r in invoke("list_rooms") if r["id"] == kitchen["id"]][0]["links"] == [])
    invoke("set_room_links", {"id": kitchen["id"], "links": [garden["id"]]})
    check("giving the kitchen its own exit to the gate leaves the gate's exit alone", [r for r in invoke("list_rooms") if r["id"] == garden["id"]][0]["links"] == [kitchen["id"]])
    extra_ = [mk_room(f"Extra {i}", "x") for i in range(4)]
    check("a room can have up to three exits", len(invoke("set_room_links", {"id": house["id"], "links": [x["id"] for x in extra_[:3]]})["links"]) == 3)
    check("a fourth exit is refused, and the three stay", "at most 3" in (inv_err("set_room_links", {"id": house["id"], "links": [x["id"] for x in extra_]}) or "") and len([r for r in invoke("list_rooms") if r["id"] == house["id"]][0]["links"]) == 3)
    invoke("set_room_links", {"id": house["id"], "links": []})
    for x_ in extra_: invoke("delete_room", {"id": x_["id"]})


    pdorm = invoke("create_dorm", {"name": "House dorm", "roomId": house["id"]})
    pchat = invoke("create_chat", {"dormId": pdorm["id"], "name": "at home", "kind": "dm", "characterIds": [mira["id"]]})
    invoke("add_user_message", {"chatId": pchat["id"], "text": "home sweet home"}); gen_and_wait(pchat["id"])
    check("in the house, the characters are told where they are and where they can go", "Setting: Our house" in sysprompt() and "Kitchen" in sysprompt() and "Living room" in sysprompt(), sysprompt()[-500:])
    reload_ui(); nav("Dorms"); time.sleep(1.0)
    d.find_element(By.XPATH, "//button[contains(@class,'it') and contains(., 'at home')]").click(); time.sleep(1.2)
    opts_ = d.execute_script("const s=document.querySelector('[aria-label=\"Go to another room\"]');return s?[...s.querySelectorAll('optgroup')].map(g=>g.label+': '+[...g.querySelectorAll('option')].map(o=>o.textContent).sort().join(', ')):null")
    check("a Go to… menu in the chat lists only the way on (the rooms inside the house), not every room", opts_ is not None and len(opts_) == 1 and opts_[0].startswith("Nearby") and "Our house › Kitchen" in opts_[0] and "Our house › Living room" in opts_[0] and "Garden gate" not in opts_[0], str(opts_))
    Select(d.find_element(By.CSS_SELECTOR, "[aria-label='Go to another room']")).select_by_visible_text("Our house › Kitchen"); time.sleep(1.5)
    moved = [c for c in invoke("list_chats") if c["id"] == pchat["id"]][0]
    check("choosing a room moves the same chat there (no new chat)", moved["room_id"] == kitchen["id"] and len([c for c in invoke("list_chats") if c["dorm_id"] == pdorm["id"]]) == 1, str(moved))
    check("the conversation shows the move and keeps its earlier messages", d.execute_script("return document.querySelector('[data-testid=travel-line]')?.textContent||''").endswith("Kitchen") and d.execute_script("return document.querySelectorAll('.msgs .msg').length") >= 2)
    check("the chat header shows the new room", "Kitchen" in d.execute_script("return document.querySelector('.chathead .tok')?.textContent||''"))
    gen_and_wait(pchat["id"])
    check("after the move, the characters are told they are in the kitchen and the move is narrated", "Setting: Kitchen" in sysprompt() and "yellow tiles" in sysprompt().lower() and "It is part of Our house" in sysprompt() and any("[The scene moves to Kitchen.]" in m["content"] for m in seen["body"]["messages"]), sysprompt()[-500:])
    check("the kitchen leads to the garden gate by its exit", "Garden gate" in sysprompt())
    exits_ = d.execute_script("const s=document.querySelector('[aria-label=\"Go to another room\"]');return s?[...s.querySelectorAll('optgroup')].map(g=>g.label+': '+[...g.querySelectorAll('option')].map(o=>o.textContent).sort().join(', ')):null")
    check("in the kitchen the menu shows its exit first", exits_ is not None and exits_[0] == "Exits: Garden gate", str(exits_))
    check("moving to the room it is already in is refused", "already" in (inv_err("move_chat", {"chatId": pchat["id"], "roomId": kitchen["id"]}) or ""))
    check("a chat can't move into a room that isn't there", bool(inv_err("move_chat", {"chatId": pchat["id"], "roomId": 99999})))
    nroom = len(invoke("list_rooms"))
    invoke("delete_room", {"id": kitchen["id"]})
    after_ = [c for c in invoke("list_chats") if c["id"] == pchat["id"]][0]
    check("deleting the room a chat is in puts it back in its dorm's room", after_["room_id"] is None and len(invoke("list_rooms")) == nroom - 1)
    check("rooms that were inside a deleted room keep existing", [r for r in invoke("list_rooms") if r["id"] == livingr["id"]][0]["parent_id"] == house["id"])
    # the pathways map on the Rooms page: rooms as cards, a line drawn from a round handle onto another room joins them
    reload_ui(); nav("Rooms"); time.sleep(1.0)
    d.execute_script("document.querySelector('[data-testid=rooms-map-tab]').click()"); time.sleep(0.8)
    n_rooms_ = len(invoke("list_rooms"))
    check("the Rooms page can show a pathways map with a card for every room", d.execute_script("return document.querySelectorAll('[data-room-node]').length") == n_rooms_ and n_rooms_ >= 3, str(n_rooms_))
    def drag_line(a_id, b_id):
        d.execute_script("""const port=document.querySelector('[data-port="'+arguments[0]+'"]'), tgt=document.querySelector('[data-room-node="'+arguments[1]+'"]');
          const pr=port.getBoundingClientRect(), tr=tgt.getBoundingClientRect();
          const mk=(t,x,y)=>new PointerEvent(t,{clientX:x,clientY:y,bubbles:true,pointerId:1,isPrimary:true});
          port.dispatchEvent(mk('pointerdown',pr.x+5,pr.y+5)); window.dispatchEvent(mk('pointermove',tr.x+40,tr.y+40)); window.dispatchEvent(mk('pointerup',tr.x+40,tr.y+40));""", a_id, b_id)
        time.sleep(1.0)
    links_of = lambda rid: [r for r in invoke("list_rooms") if r["id"] == rid][0]["links"]
    check("the garden gate has no exit to the living room yet", livingr["id"] not in links_of(garden["id"]))
    drag_line(garden["id"], livingr["id"])
    check("a drawn arrow waits as a draft: nothing is saved until Save pathways", livingr["id"] not in links_of(garden["id"]) and d.execute_script("return document.querySelector('[data-testid=map-status]').textContent") == "Unsaved changes")
    d.execute_script("document.querySelector('[data-testid=map-discard]').click()"); time.sleep(0.6)
    check("Discard puts the pathways editor back the way it was saved", d.execute_script("return document.querySelector('[data-testid=map-status]').textContent") == "Saved" and not d.execute_script("return !!document.querySelector('[data-link=\"%d-%d\"]')" % (garden["id"], livingr["id"])))
    drag_line(garden["id"], livingr["id"])
    d.execute_script("document.querySelector('[data-testid=map-save]').click()"); time.sleep(1.5)
    check("Save pathways gives the room an exit there, one way", livingr["id"] in links_of(garden["id"]) and garden["id"] not in links_of(livingr["id"]) and d.execute_script("return document.querySelector('[data-testid=map-status]').textContent") == "Saved", str(links_of(garden["id"])))
    check("the new exit is drawn on the map as an arrow", d.execute_script("return !!document.querySelector('[data-link=\"%d-%d\"]')" % (garden["id"], livingr["id"])))
    drag_line(garden["id"], garden["id"])
    check("a line dropped back on the same room joins nothing", d.execute_script("return document.querySelector('[data-testid=map-status]').textContent") == "Saved" and links_of(garden["id"]) == [livingr["id"]], str(links_of(garden["id"])))
    d.execute_script("document.querySelector('[data-unlink=\"%d-%d\"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))" % (garden["id"], livingr["id"])); time.sleep(0.8)
    check("taking an arrow away is also a draft until it is saved", livingr["id"] in links_of(garden["id"]))
    d.execute_script("document.querySelector('[data-testid=map-save]').click()"); time.sleep(1.5)
    check("the × on an arrow, then Save pathways, takes the exit away", links_of(garden["id"]) == [] and links_of(livingr["id"]) == [])

    # -- worlds: folders of connected rooms, kept apart from each other, with lorebooks that apply to every chat in them
    w_lore = {"name": "x", "entries": [{"keys": [], "content": "WORLD-LORE: dragons guard the seven nations.", "enabled": True, "constant": True, "insertion_order": 1}]}
    wlb = invoke("save_lorebook", {"lorebook": {"id": "", "name": "Tevyat lore", "book": w_lore, "created_at": 0, "updated_at": 0}})
    w1 = invoke("create_world", {"name": "  Tevyat  ", "description": "A vast world of seven nations."}); w2 = invoke("create_world", {"name": "Earth", "description": ""})
    check("a world is made, with its name trimmed", w1["name"] == "Tevyat" and w1["lorebooks"] == [] and w1["description"].startswith("A vast"), str(w1))
    check("an unnamed world is refused", "name" in (inv_err("create_world", {"name": "   ", "description": ""}) or "").lower())
    mond = mk_room("Mondstadt", "A city of wind and song.", world_id=w1["id"]); cave = mk_room("Dragon cave", "Dark and deep.", world_id=w1["id"], parent_id=mond["id"]); home = mk_room("Home sweet home", "A flat.", world_id=w2["id"])
    check("a room can be made in a world, and be part of another room in it", (mond["world_id"], cave["world_id"], cave["parent_id"]) == (w1["id"], w1["id"], mond["id"]), str(cave))
    check("exits never lead out of a world", invoke("set_room_links", {"id": mond["id"], "links": [cave["id"], home["id"]]})["links"] == [cave["id"]])
    check("a room can't be part of a room in another world", invoke("update_room", {"room": dict(cave, parent_id=home["id"])})["parent_id"] is None)
    invoke("update_room", {"room": dict(cave, parent_id=mond["id"])}); invoke("set_room_links", {"id": mond["id"], "links": [cave["id"]]})
    invoke("move_rooms_to_world", {"ids": [cave["id"]], "worldId": w2["id"]})
    rooms_now_ = {r["name"]: r for r in invoke("list_rooms")}
    check("moving one room to another world drops the links it can't keep", rooms_now_["Dragon cave"]["world_id"] == w2["id"] and rooms_now_["Dragon cave"]["parent_id"] is None and rooms_now_["Mondstadt"]["links"] == [])
    wx = mk_room("Windrise", "A hill.", world_id=w1["id"]); wy = mk_room("Statue", "Old stone.", world_id=w1["id"], parent_id=wx["id"]); invoke("set_room_links", {"id": wx["id"], "links": [wy["id"]]})
    invoke("move_rooms_to_world", {"ids": [wx["id"], wy["id"]], "worldId": w2["id"]})
    rooms_now_ = {r["name"]: r for r in invoke("list_rooms")}
    check("a connected set of rooms moves together and stays connected", rooms_now_["Statue"]["world_id"] == w2["id"] and rooms_now_["Statue"]["parent_id"] == wx["id"] and rooms_now_["Windrise"]["links"] == [wy["id"]])
    check("a world that doesn't exist is refused", "doesn't exist" in (inv_err("move_rooms_to_world", {"ids": [wx["id"]], "worldId": 99999}) or ""))
    invoke("move_rooms_to_world", {"ids": [wx["id"], wy["id"], cave["id"]], "worldId": None})
    check("rooms can be taken out of any world", all(r["world_id"] is None for r in invoke("list_rooms") if r["name"] in ("Windrise", "Statue", "Dragon cave")))
    w1u = invoke("update_world", {"id": w1["id"], "name": "Tevyat", "description": "A vast world of seven nations.", "lore": "# The Seven\n\nLong ago, seven nations rose from the sea.", "lorebooks": [wlb["id"], "not-mine"]})
    check("lorebooks can be attached to a world (the owner's own only)", w1u["lorebooks"] == [wlb["id"]], str(w1u))
    check("a world's lore is kept, with its paragraphs", w1u["lore"].startswith("# The Seven") and "\n\n" in w1u["lore"] and "rose from the sea" in w1u["lore"], str(w1u["lore"]))
    check("the lore is kept up to 20,000 characters", len(invoke("update_world", {"id": w2["id"], "name": "Earth", "description": "", "lore": "x" * 25000, "lorebooks": []})["lore"]) == 20000)
    wdorm = invoke("create_dorm", {"name": "Wind dorm", "roomId": mond["id"]}); wchat = invoke("create_chat", {"dormId": wdorm["id"], "name": "in mondstadt", "kind": "dm", "characterIds": [mira["id"]]})
    invoke("add_user_message", {"chatId": wchat["id"], "text": "where are we?"}); gen_and_wait(wchat["id"])
    swd = sysprompt()
    check("in a room of the world, the characters are told about the world and its lorebooks apply", "world of Tevyat" in swd and "seven nations" in swd and "WORLD-LORE" in swd, swd[-600:])
    check("the written lore is for reading: it is not sent to the model", "rose from the sea" not in swd and "The Seven" not in swd)
    invoke("move_chat", {"chatId": wchat["id"], "roomId": home["id"]}); invoke("add_user_message", {"chatId": wchat["id"], "text": "and now?"}); gen_and_wait(wchat["id"])
    swd2 = sysprompt()
    check("walking into a room of another world changes the world, and its lorebooks stop applying", "world of Earth" in swd2 and "WORLD-LORE" not in swd2 and "seven nations" not in swd2, swd2[-600:])

    # ---- playbooks: a story's values, and rules that change them before and after each reply ----
    pbd = {"id": "", "name": "  Trust test  ", "description": "A test story.", "instructions": "Say please.",
           "variables": [{"id": "trust", "label": "Trust", "kind": "number", "default": 2, "min": 0, "max": 10, "options": [], "note": "How much she trusts you.", "bands": [{"from": 0, "text": "wary of you"}, {"from": 3, "text": "warming up to you"}]}],
           "rules": [{"id": "polite", "name": "Please", "phase": "before", "when": [{"type": "user_says", "words": ["please"]}], "when_any": [], "ask": "", "fallback": [], "then": [{"var": "trust", "op": "add", "value": 1}]}],
           "lorebooks": [], "lore": [], "scenarios": [{"name": "Friends", "description": "old friends", "values": {"trust": 8}}], "created_at": 0, "updated_at": 0}
    pbs = invoke("save_playbook", {"playbook": pbd})
    check("a playbook is saved with a trimmed name and an id", pbs["name"] == "Trust test" and bool(pbs["id"]) and len(pbs["variables"]) == 1, str(pbs)[:200])
    check("a rule that changes a value the playbook doesn't have is refused", "doesn't have" in (inv_err("save_playbook", {"playbook": dict(pbd, rules=[dict(pbd["rules"][0], then=[{"var": "ghost", "op": "add", "value": 1}])])}) or ""))
    check("an unnamed playbook is refused", "name" in (inv_err("save_playbook", {"playbook": dict(pbd, name="  ")}) or "").lower())
    check("the list shows it, and four starters are on offer", any(x["id"] == pbs["id"] for x in invoke("list_playbooks")) and len(invoke("playbook_templates")) == 4)
    pchat = invoke("create_chat", {"dormId": wdorm["id"], "name": "story chat", "kind": "dm", "characterIds": [mira["id"]]})
    check("a chat has no playbook until one is chosen", invoke("get_chat_playbook", {"chatId": pchat["id"]})["active"] is None)
    cp = invoke("set_chat_playbook", {"chatId": pchat["id"], "mode": "set", "playbookId": pbs["id"], "scenario": None})
    check("choosing a playbook shows its values as they start, with what they mean", cp["active"]["name"] == "Trust test" and cp["values"][0]["value"] == 2 and cp["values"][0]["meaning"] == "wary of you", str(cp)[:300])
    invoke("add_user_message", {"chatId": pchat["id"], "text": "please be kind"}); gen_and_wait(pchat["id"])
    sp = sysprompt(); cp = invoke("get_chat_playbook", {"chatId": pchat["id"]})
    check("a rule that runs before the reply changes the value, and the characters are told what it now means", cp["values"][0]["value"] == 3 and "warming up to you" in sp and "wary of you" not in sp and "never mention that they are numbers" in sp, sp[-500:])
    check("the turn count moved on", cp["turn"] == 1, str(cp["turn"]))
    last_ = invoke("list_messages", {"chatId": pchat["id"]})[-1]
    def gen_swipe(args, n_swipes):
        invoke("generate", dict({"chatId": pchat["id"], "characterId": None, "regenerateMessageId": None, "continueMessageId": None}, **args))
        for _ in range(40):
            time.sleep(0.5)
            m_ = invoke("list_messages", {"chatId": pchat["id"]})[-1]
            if len(m_["swipes"]) >= n_swipes: break
        time.sleep(0.8)
    gen_swipe({"regenerateMessageId": last_["id"]}, 2)
    cp = invoke("get_chat_playbook", {"chatId": pchat["id"]})
    check("regenerating replays the turn from before it: the story does not move twice", cp["values"][0]["value"] == 3 and cp["turn"] == 1, str(cp["values"]))
    m0_ = invoke("list_messages", {"chatId": pchat["id"]})[-1]; t0_ = m0_["swipes"][m0_["swipe_index"]]
    invoke("generate", {"chatId": pchat["id"], "characterId": None, "regenerateMessageId": None, "continueMessageId": last_["id"]})
    for _ in range(40):
        time.sleep(0.5)
        m1_ = invoke("list_messages", {"chatId": pchat["id"]})[-1]
        if m1_["swipes"][m1_["swipe_index"]] != t0_: break
    time.sleep(0.8)
    cp = invoke("get_chat_playbook", {"chatId": pchat["id"]})
    check("continuing a reply does not move the story on", cp["values"][0]["value"] == 3 and cp["turn"] == 1, str(cp["values"]))
    cp = invoke("set_playbook_values", {"chatId": pchat["id"], "values": {"trust": 99}})
    check("values can be corrected by hand, and stay inside their range", cp["values"][0]["value"] == 10, str(cp["values"]))
    cp = invoke("set_chat_playbook", {"chatId": pchat["id"], "mode": "set", "playbookId": pbs["id"], "scenario": "Friends"})
    check("a starting scenario sets its values", cp["values"][0]["value"] == 8 and "old friends" not in str(cp["values"][0]["meaning"]), str(cp["values"]))
    invoke("set_chat_playbook", {"chatId": pchat["id"], "mode": "none", "playbookId": None, "scenario": None})
    invoke("add_user_message", {"chatId": pchat["id"], "text": "and now?"}); gen_and_wait(pchat["id"])
    check("with no playbook the characters are told nothing about values", "tracked by these values" not in sysprompt())
    pm = invoke("save_character", {"character": dict(invoke("get_character", {"id": mira["id"]}), playbook=pbs["id"])})
    check("a character can come with a playbook", pm.get("playbook") == pbs["id"], str(pm.get("playbook")))
    check("a playbook that isn't yours can't be attached", invoke("save_character", {"character": dict(pm, playbook="not-mine")}).get("playbook") in ("", None))
    invoke("save_character", {"character": dict(pm, playbook=pbs["id"])})
    invoke("set_chat_playbook", {"chatId": pchat["id"], "mode": "inherit", "playbookId": None, "scenario": None})
    check("a chat on the character's own playbook uses it", (invoke("get_chat_playbook", {"chatId": pchat["id"]})["active"] or {}).get("id") == pbs["id"])
    pbx = invoke("save_playbook", {"playbook": dict(pbs, id="")})
    invoke("delete_playbook", {"id": pbx["id"]})
    check("a playbook can be deleted", not any(x["id"] == pbx["id"] for x in invoke("list_playbooks")))
    # folders for playbooks and lorebooks
    fa = invoke("create_shelf_folder", {"kind": "playbooks", "name": "  Slow   burns ", "parent": None})
    fb = invoke("create_shelf_folder", {"kind": "playbooks", "name": "Romance", "parent": fa["id"]})
    check("a folder is made with a tidy name, and can hold folders", fa["name"] == "Slow burns" and fb["parent"] == fa["id"], str(fa))
    check("two folders of the same name can't sit side by side", "already" in (inv_err("create_shelf_folder", {"kind": "playbooks", "name": "slow BURNS", "parent": None}) or ""))
    invoke("move_to_shelf_folder", {"kind": "playbooks", "itemId": pbs["id"], "folder": fb["id"]})
    sh = invoke("get_shelf", {"kind": "playbooks"})
    check("a playbook can be put in a folder", sh["items"].get(pbs["id"]) == fb["id"] and len(sh["folders"]) == 2, str(sh))
    check("lorebooks have their own, separate folders", invoke("get_shelf", {"kind": "lorebooks"})["folders"] == [])
    fl = invoke("create_shelf_folder", {"kind": "lorebooks", "name": "World books", "parent": None})
    invoke("move_to_shelf_folder", {"kind": "lorebooks", "itemId": wlb["id"], "folder": fl["id"]})
    check("a lorebook can be put in a folder", invoke("get_shelf", {"kind": "lorebooks"})["items"].get(wlb["id"]) == fl["id"])
    check("a lorebook can't go in a playbook folder", inv_err("move_to_shelf_folder", {"kind": "lorebooks", "itemId": wlb["id"], "folder": fa["id"]}) is not None)
    invoke("delete_shelf_folder", {"id": fb["id"]})
    sh = invoke("get_shelf", {"kind": "playbooks"})
    check("deleting a folder moves what is inside up, and deletes nothing", sh["items"].get(pbs["id"]) == fa["id"] and any(x["id"] == pbs["id"] for x in invoke("list_playbooks")), str(sh))
    d.execute_script("localStorage.setItem('dorms.rooms.view','cards')"); reload_ui(); nav("Lorebooks"); time.sleep(1.2)
    check("the Lorebooks list shows the folder with the book inside it", d.execute_script("const f=document.querySelector('[data-shelf=lorebooks] [data-shelf-folder=\"World books\"]');return !!f && !!f.querySelector('[data-shelf-item]')"), page_text()[:200])
    invoke("delete_shelf_folder", {"id": fl["id"]})
    d.execute_script("localStorage.setItem('dorms.rooms.view','cards')"); reload_ui(); nav("Playbooks"); time.sleep(1.2)
    check("the Playbooks page lists playbooks and the starters", d.execute_script("return !!document.querySelector('[data-testid=playbooks-page]') && !!document.querySelector('[data-pb=\"%s\"]') && document.querySelectorAll('[data-starter]').length===4" % pbs["id"]), page_text()[:300])
    d.execute_script("document.querySelector('[data-testid=pb-new]').click()"); time.sleep(0.8)
    set_value("input[aria-label='Playbook name']", "Built in the UI")
    d.execute_script("document.querySelector('[data-testid=pb-add-var]').click()"); time.sleep(0.4)
    d.execute_script("document.querySelector('[data-testid=pb-add-rule]').click()"); time.sleep(0.4)
    check("the editor adds a value and a rule", d.execute_script("return document.querySelectorAll('[data-var]').length===1 && document.querySelectorAll('[data-rule]').length===1"))
    d.execute_script("[...document.querySelectorAll('[data-rule] button')].find(b=>b.textContent.includes('Add a change')).click()"); time.sleep(0.4)
    d.execute_script("document.querySelector('[data-testid=pb-save]').click()"); time.sleep(1.2)
    built = [x for x in invoke("list_playbooks") if x["name"] == "Built in the UI"]
    check("a playbook built in the editor is saved, with its value and its rule", len(built) == 1 and len(built[0]["variables"]) == 1 and len(built[0]["rules"]) == 1 and len(built[0]["rules"][0]["then"]) == 1, str(built)[:300])

    # ---- writing a novel: chapter by chapter, planned to fit the day's allowance, stopped after a finished chapter ----
    nchat = invoke("create_chat", {"dormId": wdorm["id"], "name": "novel chat", "kind": "dm", "characterIds": [mira["id"]]})
    invoke("add_user_message", {"chatId": nchat["id"], "text": "Tell me a story."})
    def wait_note(chat_id, secs=40):
        for _ in range(secs * 2):
            time.sleep(0.5)
            ms_ = invoke("list_messages", {"chatId": chat_id})
            if ms_ and ms_[-1]["role"] == "note": return ms_
        return invoke("list_messages", {"chatId": chat_id})
    seen["pieces"] = ["Chapter 1: The Loft\n\n", "The radiator knocked twice."]
    np_ = invoke("novel_start", {"chatId": nchat["id"], "plot": "  a mystery in the old library  ", "tone": "Mystery", "pov": "first person, past tense", "chapters": 3, "chapterTokens": 800, "resume": False})
    check("a novel is planned from the plot, tone and length", np_["chapters"] == 3 and np_["plot"] == "a mystery in the old library" and np_["chapter_tokens"] == 800, str(np_))
    ms_ = wait_note(nchat["id"]); seen["pieces"] = None
    chs_ = [m for m in ms_ if m["role"] == "character" and m["swipes"][0].startswith("Chapter")]
    check("each chapter is its own reply, and the writer says when the novel is finished", len(chs_) == 3 and ms_[-1]["role"] == "note" and "finished" in ms_[-1]["swipes"][0] and "Enjoy your story" in ms_[-1]["swipes"][0], str([(m["role"], m["swipes"][0][:60]) for m in ms_]))
    sp_ = sysprompt()
    check("the last chapter is asked for as the final chapter, from the plot", "chapter 3 of 3" in sp_ and "final chapter" in sp_ and "a mystery in the old library" in sp_ and "Mystery" in sp_ and "first person, past tense" in sp_ and "Carry on exactly" in sp_, sp_[-700:])
    check("a desktop can hide the app to the tray while a novel is written", invoke("tray_available") is True)
    ns_ = invoke("novel_status", {"chatId": nchat["id"]})
    check("the plan is kept, with how far it got, and nothing is left running", ns_["plan"]["done"] == 3 and not ns_["running"] and ns_["used_today"] >= 3, str(ns_))
    check("the writer's own note is never sent to the model as part of the story", "Enjoy your story" not in json.dumps(seen["body"]["messages"]))
    # planned to fit a free model's day: 9 a day, 3 kept for chatting, 3 already used
    st = invoke("get_settings"); st["novel_daily_limit"] = ns_["used_today"] + 6; st["novel_reserve"] = 3; invoke("save_settings", {"settings": st})
    seen["pieces"] = ["Chapter 1\n\n", "More story."]
    np2_ = invoke("novel_start", {"chatId": nchat["id"], "plot": "again", "tone": "", "pov": "", "chapters": 10, "chapterTokens": 800, "resume": False})
    check("a story that would not fit the day's allowance is planned shorter so it can end properly", np2_["chapters"] == 3, str(np2_))
    ms2_ = wait_note(nchat["id"], 60); seen["pieces"] = None
    check("it writes the chapters that fit and finishes", "finished" in ms2_[-1]["swipes"][0] and len([m for m in ms2_ if m["role"] == "character" and m["swipes"][0].startswith("Chapter")]) == 6, str([(m["role"], m["swipes"][0][:50]) for m in ms2_[-4:]]))
    check("with the allowance spent, a new novel is refused with the reason", "used up" in (inv_err("novel_start", {"chatId": nchat["id"], "plot": "", "tone": "", "pov": "", "chapters": 2, "chapterTokens": 800, "resume": False}) or ""))
    st = invoke("get_settings"); st["novel_daily_limit"] = 0; invoke("save_settings", {"settings": st})
    d.execute_script("localStorage.setItem('dorms.rooms.view','cards'); localStorage.removeItem('dorms.rooms.world')")
    reload_ui(); nav("Rooms"); time.sleep(1.2)
    check("the Rooms page has a bar of worlds", d.execute_script("return !!document.querySelector('[data-testid=worlds-bar]') && !!document.querySelector('[data-testid=world-chip-%d]')" % w1["id"]))
    d.execute_script("document.querySelector('[data-testid=world-chip-%d]').click()" % w1["id"]); time.sleep(0.8)
    shown_ = d.execute_script("return [...document.querySelectorAll('.room-card h3')].map(x=>x.textContent)")
    check("picking a world shows only its rooms, and its panel", any("Mondstadt" in x for x in shown_) and not any("Home sweet home" in x for x in shown_) and d.execute_script("return !!document.querySelector('[data-testid=world-panel]')"), str(shown_))
    d.execute_script("document.querySelector('[data-testid=world-read]').click()"); time.sleep(0.9)
    ov_ = d.execute_script("const o=document.querySelector('[data-testid=world-overview]');return o?o.innerText:''")
    check("a world can be read about before diving in: its lore, its rooms and its lorebooks on an overview page", "seven nations rose from the sea" in ov_ and "Mondstadt" in ov_ and "Tevyat lore" in ov_, ov_[:300])
    check("the lore's heading is drawn as a heading", d.execute_script("return !!document.querySelector('[data-testid=world-lore-read] h3')"))
    d.execute_script("[...document.querySelectorAll('.modal button')].find(b=>b.textContent.trim()==='Close').click()"); time.sleep(0.5)
    d.execute_script("document.querySelector('[data-testid=new-world]').click()"); time.sleep(0.4)
    d.find_element(By.CSS_SELECTOR, "[data-testid=new-world-name]").send_keys("Skyrealm"); d.execute_script("document.querySelector('[data-testid=new-world-create]').click()"); time.sleep(1.2)
    w3_ = [w for w in invoke("list_worlds") if w["name"] == "Skyrealm"]
    check("a world can be made from the Rooms page, and is picked at once", len(w3_) == 1 and d.execute_script("return document.querySelector('[data-testid=world-name]').value") == "Skyrealm")
    d.execute_script("const t=document.querySelector('[data-testid=world-desc]');t.focus();"); d.find_element(By.CSS_SELECTOR, "[data-testid=world-desc]").send_keys("Floating islands."); d.execute_script("document.querySelector('[data-testid=world-name]').focus()"); time.sleep(1.0)
    d.find_element(By.CSS_SELECTOR, "[data-testid=world-lore]").send_keys("The islands drift on the wind."); d.execute_script("document.querySelector('[data-testid=world-name]').focus()"); time.sleep(1.0)
    check("a world's lore is written in its panel", [w for w in invoke("list_worlds") if w["id"] == w3_[0]["id"]][0]["lore"] == "The islands drift on the wind.")
    d.execute_script("document.querySelector('[data-world-book=\"Tevyat lore\"]').click()"); time.sleep(1.0)
    w3n_ = [w for w in invoke("list_worlds") if w["id"] == w3_[0]["id"]][0]
    check("a world's description and lorebooks are set from its panel", w3n_["description"] == "Floating islands." and w3n_["lorebooks"] == [wlb["id"]], str(w3n_))
    d.execute_script("document.querySelector('[data-testid=world-make-room]').click()"); time.sleep(1.2)
    check("'Make a room in this world' starts a room in it", d.execute_script("return document.querySelector('[data-testid=room-world]').value") == str(w3_[0]["id"]))
    d.execute_script("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Cancel')).click()"); time.sleep(0.6)
    nav("Rooms"); time.sleep(0.8)
    d.execute_script("window.confirm=()=>true; document.querySelector('[data-testid=world-chip-%d]').click()" % w3_[0]["id"]); time.sleep(0.6)
    d.execute_script("document.querySelector('[data-testid=world-delete]').click()"); time.sleep(1.2)
    check("deleting a world keeps its rooms", all(w["id"] != w3_[0]["id"] for w in invoke("list_worlds")) and any(r["name"] == "Mondstadt" for r in invoke("list_rooms")))
    for nm_ in ("Mondstadt", "Home sweet home", "Windrise", "Statue", "Dragon cave"): invoke("delete_room", {"id": [r for r in invoke("list_rooms") if r["name"] == nm_][0]["id"]})
    invoke("delete_world", {"id": w1["id"]}); invoke("delete_world", {"id": w2["id"]}); invoke("delete_lorebook", {"id": wlb["id"]})
    d.execute_script("localStorage.setItem('dorms.rooms.view','map')")

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
    h0 = d.execute_script("return document.querySelector('textarea[aria-label=\"Note text\"]').getBoundingClientRect().height")
    d.find_element(By.CSS_SELECTOR, "[data-testid=note-grip]").send_keys(Keys.ARROW_DOWN, Keys.ARROW_DOWN); time.sleep(0.4)
    h1 = d.execute_script("return document.querySelector('textarea[aria-label=\"Note text\"]').getBoundingClientRect().height")
    check("the notes writing area can be made taller (arrow keys on its bar) and the height is kept", h1 > h0 + 40 and d.execute_script("return localStorage.getItem('dorms.notes.height')") is not None, f"{h0} -> {h1}")
    reload_ui(); nav("Notes"); time.sleep(0.8)
    d.execute_script("[...document.querySelectorAll('.note-item')].find(b => b.textContent.includes('Ideas for Mira')).click()"); time.sleep(0.5)
    h2 = d.execute_script("return document.querySelector('textarea[aria-label=\"Note text\"]').getBoundingClientRect().height")
    check("the height is still there after a restart", abs(h2 - h1) < 3, f"{h1} vs {h2}")
    d.execute_script("document.querySelector('[data-testid=note-grip]').dispatchEvent(new MouseEvent('dblclick', {bubbles: true}))"); time.sleep(0.4)
    check("double-clicking the bar puts it back", d.execute_script("return localStorage.getItem('dorms.notes.height')") is None)
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
    lw0_ = d.execute_script("return document.querySelector('.notes-list').offsetWidth")
    d.execute_script("const r=document.querySelector('.notes-list .resizer');r.focus();for(let i=0;i<4;i++)r.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))"); time.sleep(0.5)
    lw1_ = d.execute_script("return document.querySelector('.notes-list').offsetWidth")
    check("the Lorebooks list can be made wider, and the width is remembered", lw1_ > lw0_ and d.execute_script("return Number(localStorage.getItem('dorms.panel.lorebooks'))") >= lw1_ - 2, f"{lw0_} {lw1_}")
    d.execute_script("document.querySelector('.notes-list .resizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))"); time.sleep(0.4)
    check("double-clicking the wall puts the list back", d.execute_script("return document.querySelector('.notes-list').offsetWidth") == lw0_)
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
    check("Settings has a Personas tab, personas are optional and there is no separate default persona", text_present("Personas") and d.execute_script("return !!document.querySelector('[data-testid=no-personas]') && !document.querySelector('.persona-card[data-persona=default]')"))
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

    # -- the menu on your profile at the bottom of the side bar, and Left / Right / Backspace to go back and forward
    def ctx_me():
        d.execute_script("const e=document.querySelector('[data-testid=me-row]');const r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+10}))"); time.sleep(0.5)
    ctx_me()
    items_ = d.execute_script("return [...document.querySelectorAll('[data-testid=profile-menu] button')].map(b=>b.textContent.replace(/^[^A-Za-z]+/,'').trim())")
    check("right-clicking your profile at the bottom opens a menu (the guest space can't be hidden, so it has no hide option)", items_ == ["Quick settings", "Switch accounts"], str(items_))
    check("the menu has the first option ready for the keyboard", d.execute_script("return document.activeElement && document.activeElement.dataset.testid==='pm-quick'"))
    ActionChains(d).send_keys(Keys.ARROW_DOWN).perform(); time.sleep(0.2)
    check("the arrow keys move through the menu", d.execute_script("return document.activeElement && document.activeElement.dataset.testid==='pm-switch'"))
    ActionChains(d).send_keys(Keys.ESCAPE).perform(); time.sleep(0.3)
    check("Escape closes the menu", d.execute_script("return !document.querySelector('[data-testid=profile-menu]')"))
    ctx_me(); d.execute_script("document.querySelector('[data-testid=pm-quick]').click()"); time.sleep(0.8)
    check("Quick settings opens a small window with the settings people reach for", d.execute_script("const q=document.querySelector('[data-testid=quick-settings]');return !!q && q.innerText.includes('Theme') && q.innerText.includes('Text size in chats') && q.innerText.includes('Animate decorations')"))
    click_text(".modal button.chip", "Midnight"); time.sleep(0.8)
    check("a quick setting is saved straight away", invoke("get_settings")["theme"] == "midnight")
    click_text(".modal button.chip", "Dusk"); time.sleep(0.6)
    before_ = d.execute_script("const n=document.querySelector('.nav.on');return n?n.textContent:''")
    ActionChains(d).send_keys(Keys.ARROW_LEFT).perform(); time.sleep(0.4)
    check("the arrow keys do nothing to the page behind an open window", d.execute_script("const n=document.querySelector('.nav.on');return n?n.textContent:''") == before_)
    click_text(".modal button", "Done"); time.sleep(0.5)
    nav("Notes"); nav("Rooms"); nav("Lorebooks")
    on_ = lambda: d.execute_script("const n=document.querySelector('.nav.on');return n?n.textContent:''")
    ActionChains(d).send_keys(Keys.ARROW_LEFT).perform(); time.sleep(0.5)
    check("the Left arrow goes back to the page before", "Rooms" in on_(), on_())
    ActionChains(d).send_keys(Keys.BACKSPACE).perform(); time.sleep(0.5)
    check("Backspace goes back too", "Notes" in on_(), on_())
    ActionChains(d).send_keys(Keys.ARROW_RIGHT).perform(); time.sleep(0.5)
    check("the Right arrow goes forward again", "Rooms" in on_(), on_())
    nav("Settings"); time.sleep(0.5)
    inp_ = d.find_elements(By.CSS_SELECTOR, "input[type=text]")
    if inp_:
        inp_[0].click(); ActionChains(d).send_keys(Keys.ARROW_LEFT).send_keys(Keys.BACKSPACE).perform(); time.sleep(0.4)
        check("while you are typing in a box the keys edit the text and never change the page", "Settings" in on_(), on_())
    dismiss()
    d.execute_script("document.querySelector('[data-testid=me-row]').scrollIntoView()"); ctx_me(); d.execute_script("document.querySelector('[data-testid=pm-switch]').click()"); time.sleep(1.2)
    check("Switch accounts goes back to choosing an account", "Welcome" in page_text() or d.execute_script("return !document.querySelector('[data-testid=me-row]')"), page_text()[:200])
    invoke("sign_in", {"profileId": None}); reload_ui(); time.sleep(0.8)
    # hiding an account: off the start screen, into Settings' list of hidden accounts, with a prompt to make another or use the guest space
    invoke("create_profile", {"handle": "Hider", "displayName": None, "passcode": None}); reload_ui(); time.sleep(1.0)
    ctx_me()
    items_ = d.execute_script("return [...document.querySelectorAll('[data-testid=profile-menu] button')].map(b=>b.textContent.replace(/^[^A-Za-z]+/,'').trim())")
    check("an account's menu also has Hide profile", items_ == ["Quick settings", "Switch accounts", "Hide profile"], str(items_))
    d.execute_script("window.confirm=()=>true"); d.execute_script("document.querySelector('[data-testid=pm-hide]').click()"); time.sleep(1.2)
    check("hiding an account takes you to the start screen and asks what next (this was the only account)", d.execute_script("const n=document.querySelector('[data-testid=hidden-notice]');return !!n && n.innerText.includes('only account') && !!document.querySelector('[data-testid=hn-create]') && !!document.querySelector('[data-testid=hn-guest]')"), page_text()[:300])
    check("and the hidden account is not on the start screen's list", "Hider" not in d.execute_script("return [...document.querySelectorAll('.ccard')].map(e=>e.innerText).join('|')"))
    d.execute_script("document.querySelector('[data-testid=hn-guest]').click()"); time.sleep(1.2)
    check("'Use as guest' opens the guest space", d.execute_script("const m=document.querySelector('[data-testid=me-row]');return !!m && m.innerText.includes('Guest')"))
    nav("Settings"); click_text("button[role=tab]", "Profile"); time.sleep(0.8)
    check("Settings → Profile lists the hidden account", d.execute_script("return !!document.querySelector('[data-testid=hidden-accounts] [data-hidden-account=Hider]')"))
    d.execute_script("document.querySelector('[data-testid=ha-show]').click()"); time.sleep(1.0)
    check("Show again puts it back, and the list goes away", d.execute_script("return !document.querySelector('[data-testid=hidden-accounts]')") and any(p["handle"] == "Hider" for p in invoke("session_state")["profiles"]))
    hid_id = [p["id"] for p in invoke("session_state")["profiles"] if p["handle"] == "Hider"][0]
    invoke("sign_in", {"profileId": hid_id, "passcode": None}); invoke("delete_profile", {"confirm": "hider"}); invoke("sign_in", {"profileId": None}); reload_ui(); time.sleep(0.8)

    # -- the characters list on the right, the draggable walls between the panels, and the side bar's own order
    st0 = invoke("get_settings")
    def set_provider(**kw):
        st = invoke("get_settings"); st.update(kw); invoke("save_settings", {"settings": st})
    set_provider(provider="local"); reload_ui(); nav("Characters"); time.sleep(0.8)
    d.execute_script("const t=document.querySelector('.members-tab'); if (t) t.click();"); time.sleep(0.8)
    chars_now = invoke("list_characters")
    check("the characters list opens on the right with every character in it", d.execute_script("return !!document.querySelector('[data-testid=members] .members')") and d.execute_script("return document.querySelectorAll('[data-testid=members] .m-row').length") == len(chars_now), str(len(chars_now)))
    pres = lambda: d.execute_script("const h=document.querySelector('[data-testid=members-health]');return h?h.dataset.presence:''")
    lights = lambda: d.execute_script("return [...new Set([...document.querySelectorAll('[data-testid=member-light]')].map(x=>[...x.classList].find(c=>['on','warn','off','idle'].includes(c))))].join(',')")
    wait(10).until(lambda x: pres() not in ("", "checking"))
    check("with the built-in model the light is green", pres() == "local" and lights() == "on", f"{pres()} {lights()}")
    set_provider(provider="openai", openai_base_url="http://127.0.0.1:18999/v1", openai_model="fake-model"); reload_ui(); nav("Characters"); time.sleep(1.5)
    wait(10).until(lambda x: pres() not in ("", "checking"))
    check("a cloud model that answers makes the light green and names the model", pres() == "ok" and lights() == "on" and "fake-model" in d.execute_script("return document.querySelector('[data-testid=members-health]').innerText"), f"{pres()} {lights()}")
    set_provider(openai_base_url="http://127.0.0.1:1/v1"); reload_ui(); nav("Characters"); time.sleep(1.5)
    wait(15).until(lambda x: pres() not in ("", "checking"))
    check("a cloud model that can't be reached turns every light red and says why", pres() == "down" and lights() == "off" and "reach" in d.execute_script("return document.querySelector('[data-testid=members-health]').innerText").lower(), f"{pres()} {lights()}")
    set_provider(openai_base_url="http://127.0.0.1:18999/v1")
    # Tokenator: counts need no model; shortening and drafting use the person's own model and change nothing by themselves
    tk_name = chars_now[0]["card"]["name"]
    seen["pieces"] = ["Short and ", "sweet."]
    tk_out = invoke("tokenator_run", {"mode": "trim", "field": "description", "text": "A very long and winding description that repeats itself a lot. " * 5, "notes": "", "context": "", "targetTokens": 60})
    check("Tokenator shortens a field with the person's model", tk_out == "Short and sweet." and "about 60 tokens" in seen["body"]["messages"][0]["content"], str(tk_out))
    seen["pieces"] = ["She likes tea."]
    tk_d = invoke("tokenator_run", {"mode": "draft", "field": "personality", "text": "", "notes": "shy, likes tea", "context": "", "targetTokens": 100})
    check("Tokenator drafts a field from notes", tk_d == "She likes tea." and "shy, likes tea" in seen["body"]["messages"][1]["content"], str(tk_d))
    check("Tokenator refuses an empty field and an unknown field", "nothing" in str(inv_err("tokenator_run", {"mode": "trim", "field": "description", "text": " ", "notes": "", "context": "", "targetTokens": 60})).lower() and bool(inv_err("tokenator_run", {"mode": "trim", "field": "name", "text": "x", "notes": "", "context": "", "targetTokens": 60})))
    check("the instructions sent to the model have no stray backslashes, and the notes arrive on their own lines", "\\" not in seen["body"]["messages"][0]["content"] and "\n" in seen["body"]["messages"][1]["content"] and "\\n" not in seen["body"]["messages"][1]["content"], json.dumps(seen["body"]["messages"])[:300])
    n_prompts_ = len(invoke("list_prompts"))
    seen["pieces"] = ["TITLE: Slow it down\nLABEL: Pace\nTEXT:\n", "Let's take this scene more slowly, {{char}}."]
    mk_ = invoke("tokenator_make", {"kind": "prompt", "notes": "a way to slow the story down", "context": ""})
    check("Tokenator writes a prompt from an idea, as a title, label and text", mk_ == {"title": "Slow it down", "tag": "Pace", "body": "Let's take this scene more slowly, {{char}}."} and "saved prompts" in seen["body"]["messages"][0]["content"] and "a way to slow the story down" in seen["body"]["messages"][1]["content"], str(mk_))
    check("and saves nothing by itself", len(invoke("list_prompts")) == n_prompts_)
    n_books_ = len(invoke("list_lorebooks"))
    seen["pieces"] = ["ENTRY: The Old Library\nKEYS: library, books\nTEXT: A crumbling hall of shelves that closes at dusk.\n\n", "ENTRY: Tea seller\nKEYS: tea\nTEXT: Knows everyone's order."]
    lb_ = invoke("tokenator_make", {"kind": "lorebook", "notes": "a tea district with a library", "context": "Lorebook: Quarter. Entries it already has, which must not be repeated: none."})
    check("Tokenator writes lorebook entries from an idea (name, keys, text)", [e["name"] for e in lb_["entries"]] == ["The Old Library", "Tea seller"] and lb_["entries"][0]["keys"] == ["library", "books"] and "must not be repeated" in seen["body"]["messages"][1]["content"] and "lorebooks" in seen["body"]["messages"][0]["content"], str(lb_))
    check("and saves no lorebook by itself", len(invoke("list_lorebooks")) == n_books_)
    n_pb_, n_rooms_ = len(invoke("list_playbooks")), len(invoke("list_rooms"))
    seen["pieces"] = ["NAME: Slow burn\nWHAT: Trust that grows with kindness.\nHOW: Be kind.\n", "VALUE: Trust | number | 0-10 | starts 2 | how much they trust you | 0=a wary stranger, 3=a friend\nVALUE: Mood | choice | calm, cheerful, tense | starts calm | how they feel\n", "RULE: Kind words | player says: thank you, please | trust +1; mood = cheerful\nRULE: Rude | player says: idiot | trust -2; mood = tense; ghost +5"]
    pbk_ = invoke("tokenator_make", {"kind": "playbook", "notes": "a slow friendship", "context": ""})
    check("Tokenator writes a playbook from an idea: values with ranges and meanings, and rules that change them", pbk_["name"] == "Slow burn" and [v["id"] for v in pbk_["variables"]] == ["trust", "mood"] and len(pbk_["variables"][0]["bands"]) == 2 and [len(r["then"]) for r in pbk_["rules"]] == [2, 2] and "VALUE:" in seen["body"]["messages"][0]["content"], str(pbk_)[:300])
    seen["pieces"] = ["NAME: Moon Gate Attic\nKIND: Other\nTEXT: A round window high up.\nFairy lights on the beams."]
    rmk_ = invoke("tokenator_make", {"kind": "room", "notes": "a cosy attic", "context": ""})
    check("Tokenator describes a room: name, kind and description", rmk_ == {"name": "Moon Gate Attic", "kind": "other", "description": "A round window high up.\nFairy lights on the beams."}, str(rmk_))
    seen["pieces"] = ["NAME: Harbour\nABOUT: A moonlit harbour town.\nLORE: Fishing boats and lamps.\n\nThe tide is gentle.\nROOM: Harbour Office | office | Maps and ropes.\nROOM: Lighthouse | rooftop | A tall white tower.\nROOM: Fish Market | kitchen | Crates and gulls.\nLINK: Harbour Office -> Lighthouse\nLINK: Harbour Office -> Fish Market\nLINK: Lighthouse -> Nowhere"]
    wdk_ = invoke("tokenator_make", {"kind": "world", "notes": "a harbour town", "context": "World: Harbour."})
    check("Tokenator maps out a world: lore, rooms with kinds, and which rooms connect", wdk_["description"] == "A moonlit harbour town." and "tide is gentle" in wdk_["lore"] and [r["name"] for r in wdk_["rooms"]] == ["Harbour Office", "Lighthouse", "Fish Market"] and wdk_["rooms"][0]["kind"] == "office" and wdk_["links"] == [["Harbour Office", "Lighthouse"], ["Harbour Office", "Fish Market"]], str(wdk_)[:300])
    check("and none of the three saves anything by itself", len(invoke("list_playbooks")) == n_pb_ and len(invoke("list_rooms")) == n_rooms_)
    check("Tokenator refuses an empty idea and a kind it can't write", "little about" in str(inv_err("tokenator_make", {"kind": "prompt", "notes": " ", "context": ""})) and bool(inv_err("tokenator_make", {"kind": "ship", "notes": "x", "context": ""})))
    seen["pieces"] = None
    nav("Characters"); time.sleep(0.8)
    d.execute_script("[...document.querySelectorAll('.ccard h3')].find(x=>x.textContent===arguments[0]).click()", tk_name); time.sleep(1.5)
    d.execute_script("document.querySelector('[data-testid=tokenator-open]').click()"); time.sleep(0.8)
    check("the editor's Tokenator button shows a count for each field and names the model", d.execute_script("return document.querySelectorAll('[data-testid^=tok-row-]').length")==7 and "cloud model" in d.execute_script("return document.querySelector('[data-testid=tok-model]').innerText"))
    seen["pieces"] = ["Trimmed."]
    d.execute_script("document.querySelector('[data-testid=tok-trim-description]').click()"); time.sleep(2.0)
    check("a shortened field is shown before and after, and not applied until accepted", d.execute_script("const a=document.querySelector('[data-testid=tok-after]');return !!a&&a.textContent==='Trimmed.'&&!!document.querySelector('[data-testid=tok-before]')") and by_name(tk_name)["card"]["description"] != "Trimmed.")
    d.execute_script("document.querySelector('[data-testid=tok-discard]').click()"); time.sleep(0.4)
    check("Discard drops the suggestion", d.execute_script("return !document.querySelector('[data-testid=tok-result]')"))
    seen["pieces"] = None
    dismiss()
    lbk_ = invoke("save_lorebook", {"lorebook": {"id": "", "name": "Quarter", "book": {"name": "Quarter", "description": "", "scan_depth": None, "token_budget": None, "recursive_scanning": None, "extensions": {}, "entries": []}, "created_at": 0, "updated_at": 0}})
    reload_ui(); nav("Lorebooks"); time.sleep(1.0)
    seen["pieces"] = ["ENTRY: Moon Gate\nKEYS: moon, gate\nTEXT: A round window high in the attic.\n\n", "ENTRY: Canal\nKEYS: canal, water\nTEXT: Lanterns line both banks."]
    d.execute_script("document.querySelector('.notes-list .note-item').click()"); time.sleep(0.8)
    n_ent0_ = d.execute_script("return document.querySelectorAll('.notes-main .entry').length")
    d.execute_script("document.querySelector('.notes-main [data-testid=tokenator-make-lorebook]').click()"); time.sleep(0.5)
    set_value("[data-testid=tokenator-make-notes]", "a moonlit canal district"); time.sleep(0.3)
    d.execute_script("document.querySelector('[data-testid=tokenator-make-go]').click()"); time.sleep(2.5)
    check("the lorebook editor shows the drafted entries first and adds none yet", d.execute_script("return document.querySelectorAll('[data-testid=tokenator-lore-entry]').length")==2 and d.execute_script("return document.querySelectorAll('.notes-main .entry').length")==n_ent0_)
    d.execute_script("document.querySelector('[data-testid=tokenator-make-accept]').click()"); time.sleep(0.6)
    time.sleep(0.8)
    lbs_ = [b for b in invoke("list_lorebooks") if b["id"] == lbk_["id"]]
    check("accepting adds the entries to the lorebook and saves it, after the entries already there, with their keys", len(lbs_) == 1 and [e["name"] for e in lbs_[0]["book"]["entries"]][-2:] == ["Moon Gate", "Canal"] and lbs_[0]["book"]["entries"][-2]["keys"] == ["moon", "gate"] and len(lbs_[0]["book"]["entries"]) == n_ent0_ + 2, str(lbs_)[:300])
    invoke("delete_lorebook", {"id": lbk_["id"]})
    seen["pieces"] = None
    # the playbook helper (builds on what is there, saves nothing until Save) and the world helper (makes rooms and joins them)
    seen["pieces"] = ["NAME: Slow burn\nWHAT: Trust that grows with kindness.\nHOW: Be kind.\nVALUE: Trust | number | 0-10 | starts 2 | how much they trust you | 0=a wary stranger, 3=a friend\nRULE: Kind words | player says: thank you | trust +1"]
    reload_ui(); nav("Playbooks"); time.sleep(0.8)
    d.execute_script("document.querySelector('[data-testid=pb-new]').click()"); time.sleep(1.0)
    d.execute_script("document.querySelector('[data-testid=tokenator-make-playbook]').click()"); time.sleep(0.4)
    set_value("[data-testid=tokenator-make-notes]", "a slow friendship"); time.sleep(0.3)
    d.execute_script("document.querySelector('[data-testid=tokenator-make-go]').click()"); time.sleep(2.5)
    check("the playbook helper shows its draft first and adds nothing yet", d.execute_script("return !!document.querySelector('[data-testid=tokenator-playbook-preview]') && document.querySelectorAll('[data-var]').length===0"))
    d.execute_script("document.querySelector('[data-testid=tokenator-make-accept]').click()"); time.sleep(0.8)
    time.sleep(0.8)
    made_pb_ = [x for x in invoke("list_playbooks") if x["name"] == "Slow burn"]
    check("accepting saves the playbook with its values and rules", len(made_pb_) == 1 and [v["id"] for v in made_pb_[0]["variables"]] == ["trust"] and len(made_pb_[0]["rules"]) == 1 and len(invoke("list_playbooks")) == n_pb_ + 1, str(made_pb_)[:300])
    for x_ in made_pb_: invoke("delete_playbook", {"id": x_["id"]})
    w_ = invoke("create_world", {"name": "Harbour test", "description": ""}); w_lore_ = w_["lore"]; rooms_before_ = {r["id"] for r in invoke("list_rooms")}
    seen["pieces"] = ["NAME: Harbour\nABOUT: A moonlit harbour town.\nLORE: Fishing boats and lamps.\nROOM: Harbour Office | office | Maps and ropes.\nROOM: Lighthouse | rooftop | A tall white tower.\nLINK: Harbour Office -> Lighthouse"]
    reload_ui(); nav("Rooms"); time.sleep(1.0)
    d.execute_script("document.querySelector('[data-testid=world-chip-%d]').click()" % w_["id"]); time.sleep(0.8)
    d.execute_script("document.querySelector('[data-testid=world-panel] [data-testid=tokenator-make-world]').click()"); time.sleep(0.4)
    set_value("[data-testid=tokenator-make-notes]", "a harbour town"); time.sleep(0.3)
    d.execute_script("document.querySelector('[data-testid=tokenator-make-go]').click()"); time.sleep(2.5)
    check("the world helper shows rooms and links first, and makes none yet", d.execute_script("return !!document.querySelector('[data-testid=tokenator-world-preview]')") and {r["id"] for r in invoke("list_rooms")} == rooms_before_)
    d.execute_script("document.querySelector('[data-testid=tokenator-make-accept]').click()"); time.sleep(2.5)
    new_ = [r for r in invoke("list_rooms") if r["id"] not in rooms_before_]
    ho_ = next((r for r in new_ if r["name"] == "Harbour Office"), None); lh_ = next((r for r in new_ if r["name"] == "Lighthouse"), None)
    check("accepting makes the rooms in that world, with their kinds, and joins them", bool(ho_ and lh_) and ho_["world_id"] == w_["id"] and ho_["kind"] == "office" and lh_["id"] in (ho_.get("links") or []), str(new_)[:300])
    wnow_ = next(x for x in invoke("list_worlds") if x["id"] == w_["id"])
    check("and adds to the world's lore, and fills its description because it was empty", wnow_["lore"].startswith(w_lore_) and "Fishing boats" in wnow_["lore"] and wnow_["description"] == "A moonlit harbour town.", str(wnow_)[:200])
    for r_ in new_: invoke("delete_room", {"id": r_["id"]})
    invoke("delete_world", {"id": w_["id"]})
    seen["pieces"] = None
    # the Tokenator chat: a helper that is not a character, with the guide built in, honest about files, and a personality you can drag in
    def tchat(msgs, personality=None): return invoke("tokenator_chat", {"messages": msgs, "personality": personality})
    um = lambda text, attached=0, images=(): {"role": "user", "text": text, "attached": attached, "images": list(images)}
    seen["pieces"] = ["Playbooks keep track of values."]
    c1_ = tchat([um("What is a playbook and how do the rules work?")]); sys1_ = seen["body"]["messages"][0]["content"]
    check("a question about the app brings in the built-in guide, and says which parts it read", c1_["reply"] == "Playbooks keep track of values." and len(c1_["sources"]) > 0 and "### " in sys1_ and "playbook" in sys1_.lower(), str(c1_["sources"]))
    c2_ = tchat([um("Write me a short poem about the sea")]); sys2_ = seen["body"]["messages"][0]["content"]
    check("a question that is not about the app brings in no guide at all", c2_["sources"] == [] and "### " not in sys2_ and "No part of the app's guide" in sys2_)
    tchat([um("what is this?", 1)]); b3_ = seen["body"]
    check("with a file the model was not given, nothing is sent and the model is told it cannot see it", "image_url" not in json.dumps(b3_) and "cannot see them" in b3_["messages"][-1]["content"] and "cannot see any pictures" in b3_["messages"][0]["content"])
    tchat([um("what is this?", 1, ["data:image/jpeg;base64,AAAA"])]); b4_ = seen["body"]
    check("with a picture the model can be sent, it goes in the message as an image", isinstance(b4_["messages"][-1]["content"], list) and b4_["messages"][-1]["content"][1]["image_url"]["url"] == "data:image/jpeg;base64,AAAA" and "you can look at them" in b4_["messages"][0]["content"])
    tchat([um("hi")], "Talk like a pirate."); sys5_ = seen["body"]["messages"][0]["content"]
    check("a personality changes how it talks, and the rules still come first", "<personality>" in sys5_ and "Talk like a pirate." in sys5_ and "only HOW you talk" in sys5_ and sys5_.index("Rules you always follow") < sys5_.index("<personality>"))
    check("an empty chat is refused", "first" in str(inv_err("tokenator_chat", {"messages": [], "personality": None})).lower())
    d.execute_script("localStorage.removeItem('dorms.tokenator.chat');localStorage.removeItem('dorms.tokenator.personality');localStorage.removeItem('dorms.tokenator.sees.fake-model')")
    reload_ui(); nav("Tokenator"); time.sleep(1.0)
    check("the Tokenator section opens a chat from the side bar", d.execute_script("return !!document.querySelector('[data-testid=tokenator-chat]')"))
    check("it says which model is in use, and offers a switch for pictures when it cannot tell", "fake-model" in d.execute_script("return document.querySelector('[data-testid=tchat-model]').innerText") and d.execute_script("return !!document.querySelector('[data-testid=tchat-sees]')"))
    send_ = lambda txt, secs=3.0: (set_value("[data-testid=tchat-input]", txt), time.sleep(0.3), d.execute_script("document.querySelector('[data-testid=tchat-send]').click()"), time.sleep(secs))
    last_ = lambda role: d.execute_script("const m=[...document.querySelectorAll('[data-testid=tchat-msgs] .tmsg[data-role=%s]')];return m.length?m[m.length-1].innerText:''" % role)
    seen["pieces"] = ["Playbooks keep track of values in a story."]
    send_("How do playbooks work?")
    check("a message gets a reply, with a line saying which parts of the guide it read", "keep track of values" in last_("assistant") and "Read from the app guide" in last_("assistant"), last_("assistant"))
    from PIL import Image as _ImgT
    png_ = os.path.join(WORK, "chat-pic.png"); _ImgT.new("RGB", (60, 40), (200, 60, 60)).save(png_)
    def attach_(path):
        i_ = d.find_element(By.CSS_SELECTOR, "[data-testid=tchat-file]"); d.execute_script("arguments[0].hidden=false;arguments[0].style.display='block';", i_); i_.send_keys(path); time.sleep(0.6)
    seen["pieces"] = ["I can't tell what the picture shows."]
    attach_(png_); send_("what is in this picture?")
    check("a model that may not see pictures is not sent the file, and the app says so in plain words", "image_url" not in json.dumps(seen["body"]) and "can't see attached files" in last_("note") and "cannot see them" in seen["body"]["messages"][-1]["content"], last_("note"))
    d.execute_script("document.querySelector('[data-testid=tchat-sees]').click()"); time.sleep(0.4)
    seen["pieces"] = ["A red rectangle."]
    attach_(png_); send_("and now?", 4.0)
    check("with the picture switch on, the picture goes to the model", "image_url" in json.dumps(seen["body"]) and "data:image/jpeg;base64," in json.dumps(seen["body"]) and "A red rectangle" in last_("assistant"), json.dumps(seen["body"])[:200])
    d.execute_script("const t=document.querySelector('[data-testid=tokenator-chat]');const dt=new DataTransfer();dt.setData('application/x-dorms-prompt',JSON.stringify({title:'Pirate',body:'Talk like a pirate, {{char}}.'}));t.dispatchEvent(new DragEvent('dragover',{dataTransfer:dt,bubbles:true,cancelable:true}));t.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}))"); time.sleep(0.6)
    check("dragging a prompt onto the chat gives Tokenator that personality, shown with a way back", "Pirate" in d.execute_script("return document.querySelector('[data-testid=tchat-persona]').innerText") and "still Tokenator" in last_("note"))
    seen["pieces"] = ["Arr, hello."]
    send_("hello")
    check("the personality is sent with the next message", "Talk like a pirate, Tokenator." in seen["body"]["messages"][0]["content"])
    d.execute_script("document.querySelector('[data-testid=tchat-persona-clear]').click()"); time.sleep(0.4)
    seen["pieces"] = ["Hello."]
    send_("hello again")
    check("and 'back to normal' takes it away", "<personality>" not in seen["body"]["messages"][0]["content"])
    d.execute_script("localStorage.removeItem('dorms.tokenator.chat');localStorage.removeItem('dorms.tokenator.personality');localStorage.removeItem('dorms.tokenator.sees.fake-model')")
    seen["pieces"] = None
    pc_ = invoke("phone_check")
    check("the phone check works on any device and, away from a phone, says it is not one", pc_["is_android"] is False and pc_["ram_gb"] > 0 and len(pc_["options"]) == 3 and isinstance(pc_["summary"], str) and pc_["summary"] != "")
    # Wi-Fi transfer: this app sends its open profile to itself over a real connection on this computer (a second device is not available here)
    def tpoll(role, phases, secs=40):
        end = time.time() + secs
        while time.time() < end:
            t_ = invoke("transfer_status", {"role": role})
            if t_["phase"] in phases: return t_
            time.sleep(0.4)
        return invoke("transfer_status", {"role": role})
    chars_n_ = len(invoke("list_characters"))
    s1_ = invoke("transfer_send_start", {"code": "pizza \U0001F355", "passcode": None})
    check("the sender opens, listens, and shows an address, a QR code and the code it was given", s1_["phase"] == "waiting" and ":" in s1_["addr"] and "<svg" in s1_["qr_svg"] and s1_["code"] == "pizza \U0001F355" and 0 < s1_["expires_in"] <= 300, str(s1_)[:200])
    invoke("transfer_receive_start", {"addr": s1_["addr"], "code": "pizza"})
    r1_ = tpoll("receive", ["failed"])
    s1b_ = invoke("transfer_status", {"role": "send"})
    check("a wrong code does not pair; the receiver is told, the sender counts the try and keeps waiting", r1_["phase"] == "failed" and "doesn't check out" in r1_["message"] and s1b_["phase"] == "waiting" and "2 tries left" in s1b_["message"], f"{r1_['message']} | {s1b_['message']}")
    invoke("transfer_receive_start", {"addr": s1_["addr"], "code": "pizza \U0001F355"})
    r2_ = tpoll("receive", ["arrived", "failed"])
    check("the right code, with any characters in it, brings the profile across, and it waits to be looked at", r2_["phase"] == "arrived" and bool(r2_["token"]), str(r2_)[:200])
    s2_ = tpoll("send", ["done", "failed"])
    check("the sender says it is done", s2_["phase"] == "done" and "Sent" in s2_["message"], s2_["message"])
    pv_ = invoke("inspect_staged", {"token": r2_["token"]})
    check("what arrived has the same characters as what was sent", pv_["characters"] == chars_n_, str(pv_))
    ses_ = invoke("import_staged", {"token": r2_["token"], "handle": "WifiCopy", "passcode": ""})
    check("it is added as a new profile only when the person says so", ses_["profile"]["handle"] == "WifiCopy" and len(invoke("list_characters")) == chars_n_, str(ses_["profile"])[:120])
    invoke("delete_profile", {"confirm": "wificopy"}); invoke("sign_in", {"profileId": None})
    invoke("transfer_send_start", {"code": "tidepool", "passcode": None}); s3_ = invoke("transfer_status", {"role": "send"})
    for i_ in range(3):
        invoke("transfer_receive_start", {"addr": s3_["addr"], "code": "wrong%d" % i_}); tpoll("receive", ["failed"]); time.sleep(0.3)
    s3b_ = tpoll("send", ["failed"])
    check("three wrong codes lock the sender", s3b_["phase"] == "failed" and "locked" in s3b_["message"], s3b_["message"])
    invoke("transfer_receive_start", {"addr": s3_["addr"], "code": "tidepool"}); r3_ = tpoll("receive", ["failed", "arrived"])
    check("once locked, even the right code gets no answer", r3_["phase"] == "failed" and "couldn't reach" in r3_["message"], r3_["message"])
    check("an address that is out on the internet is refused", "home network" in str(inv_err("transfer_receive_start", {"addr": "8.8.8.8:5000", "code": "x"})))
    check("a sender needs a code", "code" in str(inv_err("transfer_send_start", {"code": "", "passcode": None})).lower())
    # the same thing through the screens
    reload_ui(); nav("Settings"); d.execute_script("[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Profiles').click()"); time.sleep(0.6)
    d.execute_script("document.querySelector('[data-testid=wifi-open]').click()"); time.sleep(0.6)
    d.execute_script("document.querySelector('[data-testid=transfer-choose-send]').click()"); time.sleep(0.4)
    set_value("[data-testid=transfer-code]", "harbour"); time.sleep(0.2)
    d.execute_script("document.querySelector('[data-testid=transfer-start]').click()"); time.sleep(1.5)
    check("the Send screen shows the QR code, the address and the code", d.execute_script("return !!document.querySelector('[data-testid=transfer-qr]') && document.querySelector('[data-testid=transfer-code-shown]').textContent==='harbour' && /:\\d+$/.test(document.querySelector('[data-testid=transfer-addr]').textContent)"))
    ui_addr_ = d.execute_script("return document.querySelector('[data-testid=transfer-addr]').textContent")
    invoke("transfer_receive_start", {"addr": ui_addr_, "code": "harbour"}); tpoll("receive", ["arrived", "failed"]); time.sleep(1.5)
    check("the Send screen says when it is done", d.execute_script("const r=document.querySelector('[data-testid=transfer-send-result]');return !!r && r.textContent.includes('Sent')"))
    dismiss(); time.sleep(0.4)
    d.execute_script("document.querySelector('[data-testid=wifi-open]').click()"); time.sleep(1.5)
    check("opening it again shows what arrived, with its counts, and nothing is added yet", d.execute_script("const a=document.querySelector('[data-testid=transfer-arrived-counts]');return !!a && a.textContent.includes('character')") and len(invoke("list_characters")) == chars_n_)
    sug_ = d.execute_script("return document.querySelector('[data-testid=transfer-handle]').value")
    check("the name suggested for a received guest space is the profile's own name, not the word guest", pv_["guest"] is True and sug_ == pv_["display_name"] and "guest" not in sug_.lower(), f"{sug_!r} vs {pv_['display_name']!r}")
    d.execute_script("document.querySelector('[data-testid=transfer-discard]').click()"); time.sleep(0.5)
    check("Discard throws it away", d.execute_script("return !document.querySelector('[data-testid=transfer-arrived]') && !!document.querySelector('[data-testid=transfer-scan]')"))
    dismiss(); time.sleep(0.3)
    # statuses: in the character's voice (written by the model) or in the user's own words
    cid = chars_now[0]["id"]
    old_pieces = seen.get("pieces"); seen["pieces"] = ["studying ", "hard"]
    gen = invoke("generate_status", {"characterId": cid}); seen["pieces"] = old_pieces
    check("the model writes a status for a character, kept as theirs", gen["source"] == "ai" and gen["text"] == "studying hard" and [x["text"] for x in invoke("list_statuses")] == [gen["text"]], str(gen))
    own = invoke("set_status", {"characterId": cid, "text": "  studying for finals  "})
    check("a status can be written by hand (trimmed, marked as the user's)", own["text"] == "studying for finals" and own["source"] == "user")
    check("a status can't be made up for a character that doesn't exist", "doesn't exist" in (inv_err("set_status", {"characterId": "nope", "text": "x"}) or ""))
    reload_ui(); nav("Characters"); time.sleep(1.5)
    check("the status shows above the character's name", d.execute_script("const r=[...document.querySelectorAll('[data-testid=members] .m-row')].find(x=>x.dataset.id===arguments[0]);return !!r && r.querySelector('[data-testid=member-status]')?.textContent==='studying for finals'", cid))
    check("clearing the status removes it", invoke("set_status", {"characterId": cid, "text": ""}) is None and invoke("list_statuses") == [])
    set_provider(provider=st0["provider"], openai_base_url=st0["openai_base_url"], openai_model=st0["openai_model"])

    # -- profile decorations: a nameplate, a moving background and a wreath for the user and for each character, chosen by hand or by the model
    chars_d = invoke("list_characters"); dcid, dcid2 = chars_d[0]["id"], chars_d[1]["id"]
    r_ = invoke("set_char_deco", {"characterId": dcid, "plate": "bubbletea", "bg": "boba", "wreath": "bobacup"})
    check("a character can be dressed (nameplate, background and wreath), marked as the user's", (r_["plate"], r_["bg"], r_["wreath"], r_["source"]) == ("bubbletea", "boba", "bobacup", "user"), str(r_))
    r_ = invoke("set_char_deco", {"characterId": dcid, "plate": "evil", "bg": "../x", "wreath": "lotus"})
    check("anything that isn't a known decoration is dropped", (r_["plate"], r_["bg"], r_["wreath"]) == ("none", "", "lotus"), str(r_))
    check("choosing nothing takes the decorations off", invoke("set_char_deco", {"characterId": dcid, "plate": "none", "bg": "", "wreath": ""}) is None and invoke("list_char_deco") == [])
    check("a character that doesn't exist can't be dressed", "doesn't exist" in (inv_err("set_char_deco", {"characterId": "nope", "plate": "embers", "bg": "", "wreath": ""}) or ""))
    set_provider(provider="openai", openai_base_url="http://127.0.0.1:18999/v1", openai_model="fake-model")
    old_pieces = seen.get("pieces"); seen["pieces"] = ['Sure! {"plate": "sparkleanime", "bg": "animenight", "wreath": "magicgirl"}']
    g_ = invoke("generate_char_deco", {"characterId": dcid})
    check("the model chooses decorations for a character, kept as theirs", (g_["source"], g_["plate"], g_["bg"], g_["wreath"]) == ("ai", "sparkleanime", "animenight", "magicgirl"), str(g_))
    sysd = seen["body"]["messages"][0]["content"]
    check("the model is shown the choices and who the character is", "bubbletea (Bubble Tea" in sysd and "magicgirl (Magical Girl" in sysd and invoke("get_character", {"id": dcid})["card"]["name"] in seen["body"]["messages"][1]["content"])
    seen["pieces"] = ["Hmm, something pink."]
    check("a reply with nothing usable in it is refused, and changes nothing", "usable" in (inv_err("generate_char_deco", {"characterId": dcid}) or "") and invoke("list_char_deco")[0]["plate"] == "sparkleanime")
    seen["pieces"] = old_pieces
    st_ = invoke("get_settings"); st_["deco"] = dict(st_["deco"], plate="nonsense", wreath="catears", tag="koi!", tag_color="red", tag_glyph="?", banner="nowhere")
    sv_ = invoke("save_settings", {"settings": st_})["deco"]
    check("your own decorations are cleaned when saved (known ids, a 2 to 4 letter tag, a listed colour)", (sv_["plate"], sv_["wreath"], sv_["tag"], sv_["tag_color"], sv_["tag_glyph"], sv_["banner"]) == ("none", "catears", "KOI", "#5865f2", "", ""), str(sv_))
    d.execute_script("localStorage.setItem('dorms.members.open','1')")
    reload_ui(); nav("Settings"); d.execute_script("[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Profiles').click()"); time.sleep(0.6)
    check("the Decorations section starts folded away in the Profiles tab", d.execute_script("const f=document.querySelector('[data-testid=fold-deco]');return !!f && !f.open && !document.querySelector('[data-testid=deco-picker]')"))
    d.execute_script("document.querySelector('[data-testid=fold-deco] summary').click()"); time.sleep(1.0)
    check("Profiles has the Decorations picker and one profile card", d.execute_script("return !!document.querySelector('[data-testid=deco-picker]') && document.querySelectorAll('[data-testid=profile-card]').length===1"))
    # holiday sets that are closed today are teasers that cannot be picked (which ones are closed depends on the day, so it asks the page what it shows)
    locked = d.execute_script("return [...document.querySelectorAll('[data-theme-pick][data-locked=true]')].map(b => [b.dataset.themePick, b.disabled, b.textContent])")
    check("a closed holiday set is shown as a teaser with its opening date and cannot be picked", len(locked) > 0 and all(x[1] and "Unlocks" in x[2] for x in locked), str(locked)[:300])
    before = d.execute_script("return document.querySelector('[data-testid=deco-wearing]').textContent")
    d.execute_script("const b=document.querySelector('[data-theme-pick][data-locked=true]'); b.disabled=false; b.click()"); time.sleep(0.5)
    check("clicking a locked set changes nothing", d.execute_script("return document.querySelector('[data-testid=deco-wearing]').textContent") == before)
    check("a locked group is inert, so nothing inside it can be picked", d.execute_script("const g=document.querySelector('.dc-group.locked .dc-kinds'); return !g || g.inert === true"))
    d.execute_script("document.querySelector('[data-theme-pick=boba]').click()"); time.sleep(1.2)
    sd_ = invoke("get_settings")["deco"]
    check("choosing a theme sets a nameplate, a background and a wreath together", (sd_["plate"], sd_["bg"], sd_["wreath"]) == ("bubbletea", "boba", "bobacup"), str(sd_))
    check("the nameplate and the wreath show at the bottom left of the side bar, where your profile sits", d.execute_script("const r=document.querySelector('[data-testid=me-row]');return !!r && r.dataset.plate==='bubbletea' && !!r.querySelector('.dw[data-wreath=bobacup]')"))
    check("your profile card shows the moving background", d.execute_script("return !!document.querySelector('[data-testid=profile-card] .deco-bg[data-bg=boba]')"))
    check("the art is drawn by the page (one moving set, one still set)", d.execute_script("const s=document.getElementById('deco-art');return !!s && s.textContent.includes('data-wreath=\"bobacup\"') && s.textContent.includes('data-deco-anim=\"off\"')"))
    # the person's own decorations: a .asdeco pack goes in, is drawn, can be worn, deleted, and is not added twice
    svg_ = lambda w, h, body: f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">{body}</svg>'
    decopk_ = {"format": "anti-social-decorations", "v": 1, "name": "E2E pack", "author": "Tester", "license": "CC0", "items": [
        {"kind": "plate", "name": "Candy bar", "art": svg_(960, 176, '<rect width="960" height="176" fill="#f4a"><animate attributeName="opacity" values="1;.6;1" dur="2s" repeatCount="indefinite"/></rect>')},
        {"kind": "wreath", "name": "Gold ring", "art": svg_(576, 576, '<circle cx="288" cy="288" r="260" fill="none" stroke="gold" stroke-width="30"/>')},
        {"kind": "banner", "name": "Sky", "art": svg_(2400, 400, '<rect width="2400" height="400" fill="#38f"/>')},
        {"kind": "plate", "name": "Wrong shape", "art": svg_(100, 100, '<rect width="100" height="100"/>')}]}
    decopk_path = os.path.join(WORK, "e2e-pack.asdeco"); open(decopk_path, "w").write(json.dumps(decopk_))
    def import_decopk():
        inp_ = d.find_element(By.CSS_SELECTOR, "[data-testid=deco-import-input]")
        d.execute_script("arguments[0].hidden=false;arguments[0].style.display='block';", inp_)
        inp_.send_keys(decopk_path); wait(20).until(lambda x: x.find_elements(By.CSS_SELECTOR, "[data-testid=deco-import]")); time.sleep(0.5)
    import_decopk()
    check("a pack shows what is in it, and says what it could not use", d.execute_script("return document.querySelectorAll('[data-testid=deco-import] [data-deco-item]').length") == 3 and "Wrong shape" in d.find_element(By.CSS_SELECTOR, "[data-testid=deco-import]").text and "not added" in d.find_element(By.CSS_SELECTOR, "[data-testid=deco-import]").text)
    d.find_element(By.CSS_SELECTOR, "[data-testid=deco-import-add]").click(); time.sleep(1.2)
    mine_ = invoke("list_custom_deco")
    check("choosing Add keeps them in the person's own library", sorted(x["dkind"] for x in mine_) == ["banner", "plate", "wreath"] and all(x["pack"] == "E2E pack" and x["author"] == "Tester" for x in mine_), str(mine_)[:300])
    plate_ = next(x for x in mine_ if x["dkind"] == "plate")
    check("they come in as a collection called My decorations, drawn by the page", d.execute_script("return [...document.querySelectorAll('.dc-filters .fp-chip')].some(b => b.textContent.trim()==='My decorations') && !!document.querySelector('[data-plate-pick=\"%s\"]') && document.getElementById('deco-custom').textContent.includes('data-plate=\"%s\"')" % (plate_["did"], plate_["did"])))
    d.execute_script("document.querySelector('[data-plate-pick=\"%s\"]').click()" % plate_["did"]); time.sleep(1.0)
    check("one of them can be worn like any other, and it is kept", invoke("get_settings")["deco"]["plate"] == plate_["did"])
    d.execute_script("document.querySelector('[data-testid=deco-import-input]').value=''")
    import_decopk()
    check("adding the same pack again does not add them twice", d.execute_script("return [...document.querySelectorAll('[data-testid=deco-import] [data-deco-item]')].every(r => r.classList.contains('dim'))") and d.find_element(By.CSS_SELECTOR, "[data-testid=deco-import-add]").get_attribute("disabled") is not None)
    d.execute_script("[...document.querySelectorAll('.modal button')].find(b=>b.textContent.trim()==='Cancel').click()"); time.sleep(0.4)
    d.execute_script("document.querySelector('[data-testid=deco-manage-open]').click()"); time.sleep(0.6)
    d.execute_script("const b=document.querySelector('[data-testid=deco-delete]'); b.click()"); time.sleep(0.3)
    d.execute_script("document.querySelector('[data-testid=deco-delete]').click()"); time.sleep(1.0)
    check("a decoration can be deleted (it asks twice)", len(invoke("list_custom_deco")) == 2)
    d.execute_script("[...document.querySelectorAll('.modal button')].find(b=>b.textContent.trim()==='Done').click()"); time.sleep(0.3)
    check("a decoration with a made-up id or kind is not kept", len(invoke("list_custom_deco")) == 2 and invoke("save_custom_deco", {"items": [{"did": "cp_zzzzzzzzzz", "dkind": "plate", "mode": "svg", "name": "x", "art": "<svg></svg>"}]}) == [])
    d.execute_script("document.querySelector('[data-theme-pick=boba]').click()"); time.sleep(1.0)
    d.execute_script("[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('Name tag and banner')).click()"); time.sleep(0.7)
    tag_in_ = d.find_element(By.CSS_SELECTOR, "input[aria-label='Name tag']"); tag_in_.clear(); tag_in_.send_keys("koi!")   # (it opens holding the tag you already have)
    d.execute_script("document.querySelector('.modal [aria-label=Green]').click()"); d.execute_script("[...document.querySelectorAll('.modal button')].find(b=>b.textContent.trim()==='Save').click()"); time.sleep(1.2)
    sd_ = invoke("get_settings")["deco"]
    check("a name tag can be made (letters only, in capitals, in a chosen colour)", (sd_["tag"], sd_["tag_color"]) == ("KOI", "#23a55a"), str(sd_))
    check("the tag sits beside your name at the bottom left", d.execute_script("const t=document.querySelector('[data-testid=me-row] .srv-tag');return !!t && t.textContent.includes('KOI')"))
    d.execute_script("const c=document.querySelector('[data-testid=deco-tab] input[type=checkbox]');c.click()"); time.sleep(0.8)
    check("animation can be switched off", invoke("get_settings")["deco"]["animate"] is False and d.execute_script("return document.documentElement.dataset.decoAnim") == "off")
    d.execute_script("document.querySelector('[data-testid=deco-tab] input[type=checkbox]').click()"); time.sleep(0.6)
    # a character's own editor
    cname_ = invoke("get_character", {"id": dcid2})["card"]["name"]
    nav("Characters"); time.sleep(0.8)
    d.execute_script("[...document.querySelectorAll('.ccard h3')].find(x=>x.textContent===arguments[0]).click()", cname_); time.sleep(1.5)
    d.execute_script("[...document.querySelectorAll('[data-testid=char-deco] button')].find(b=>b.textContent.includes('Choose myself')).click()"); time.sleep(0.6)
    d.execute_script("document.querySelector('[data-testid=char-deco] [data-wreath-pick=lotus]').click()"); time.sleep(1.0)
    ld_ = [x for x in invoke("list_char_deco") if x["character_id"] == dcid2]
    check("a character's editor can dress them by hand", len(ld_) == 1 and ld_[0]["wreath"] == "lotus" and ld_[0]["source"] == "user", str(ld_))
    check("and says who chose", "you" in d.execute_script("return document.querySelector('[data-testid=char-deco-source]').textContent").lower())
    seen["pieces"] = ['{"plate":"embers","bg":"","wreath":"catears"}']
    d.execute_script("[...document.querySelectorAll('[data-testid=char-deco] button')].find(b=>b.textContent.includes('Let the model choose')).click()"); time.sleep(3.0)
    ld_ = [x for x in invoke("list_char_deco") if x["character_id"] == dcid2]
    check("the editor can ask the model to dress them", len(ld_) == 1 and ld_[0]["source"] == "ai" and ld_[0]["plate"] == "embers" and ld_[0]["wreath"] == "catears", str(ld_))
    nav("Characters"); time.sleep(1.2)
    check("a nameplate sits behind their row in the characters list, and a wreath on their picture", d.execute_script("const r=document.querySelector('[data-testid=members] .m-row[data-id=\"'+arguments[0]+'\"]');return !!r && r.dataset.plate==='embers' && !!r.querySelector('.dw[data-wreath=catears]')", dcid2))
    # the model dresses characters that have nothing, on its own, once that is switched on (never replacing a look somebody chose)
    for x_ in invoke("list_char_deco"): invoke("clear_char_deco", {"characterId": x_["character_id"]})
    invoke("set_char_deco", {"characterId": dcid, "plate": "tide", "bg": "", "wreath": ""})
    seen["pieces"] = ['{"plate":"lanternglow","bg":"lantern","wreath":"redlantern"}']
    reload_ui(); nav("Characters"); time.sleep(1.5)
    d.execute_script("document.querySelector('[data-testid=members-auto-deco]').click()"); time.sleep(0.8)
    check("the characters list has a switch for letting the model choose decorations", invoke("get_settings")["deco"]["ai_pick"] is True)
    dressed_ = lambda: {x["character_id"]: x for x in invoke("list_char_deco")}
    try: wait(60).until(lambda x: any(v["source"] == "ai" for v in dressed_().values()))
    except Exception: pass
    dv_ = dressed_()
    check("characters with no decorations get some chosen by the model, by themselves", any(v["source"] == "ai" and v["plate"] == "lanternglow" for v in dv_.values()), str(dv_))
    check("a look chosen by hand is never replaced", dv_.get(dcid, {}).get("source") == "user" and dv_[dcid]["plate"] == "tide", str(dv_.get(dcid)))
    d.execute_script("document.querySelector('[data-testid=members-auto-deco]').click()"); time.sleep(0.6)
    seen["pieces"] = old_pieces
    for x_ in invoke("list_char_deco"): invoke("clear_char_deco", {"characterId": x_["character_id"]})
    sd_ = dict(invoke("get_settings")["deco"], plate="none", bg="", wreath="", tag="", animate=True, ai_pick=False)
    st_ = invoke("get_settings"); st_["deco"] = sd_; invoke("save_settings", {"settings": st_})
    # rooms can be dressed like servers: a tag, and the same nameplate, background and wreath a profile can wear (all optional)
    rd_ = invoke("create_room", {"room": dict(room_in, name="Deco room", description="A room with a look.", owner_kind="self", character_id=None, id=0, created_at=0, deco={"plate": "evil", "bg": "boba", "wreath": "lotus", "tag": "inn!", "tag_color": "zzz", "tag_glyph": "\u2605"})})
    check("a room keeps only known decorations and a clean tag", (rd_["deco"]["plate"], rd_["deco"]["bg"], rd_["deco"]["wreath"], rd_["deco"]["tag"], rd_["deco"]["tag_color"], rd_["deco"]["tag_glyph"]) == ("none", "boba", "lotus", "INN", "#5865f2", "\u2605"), str(rd_["deco"]))
    check("a room made without any decorations has none", invoke("create_room", {"room": dict(room_in, name="Plain room", owner_kind="self", character_id=None, id=0, created_at=0)})["deco"]["tag"] == "")
    rd_ = invoke("update_room", {"room": dict(rd_, deco=dict(rd_["deco"], plate="tide"))})
    check("a room's look can be changed", rd_["deco"]["plate"] == "tide" and rd_["deco"]["wreath"] == "lotus")
    d.execute_script("localStorage.setItem('dorms.rooms.view','cards')")
    reload_ui(); nav("Rooms"); time.sleep(1.2)
    check("the room's card shows its tag, its wreath and its moving background", d.execute_script("const t=[...document.querySelectorAll('[data-testid=room-title]')].find(x=>x.textContent.includes('Deco room'));return !!t && t.dataset.plate==='tide' && !!t.querySelector('.srv-tag') && t.querySelector('.srv-tag').textContent.includes('INN') && !!t.querySelector('.dw[data-wreath=lotus]')") and d.execute_script("return !!document.querySelector('.room-art .deco-bg[data-bg=boba]')"))
    rdorm_ = invoke("create_dorm", {"name": "Deco dorm", "roomId": rd_["id"]}); rchat_ = invoke("create_chat", {"dormId": rdorm_["id"], "name": "in the deco room", "kind": "dm", "characterIds": [dcid]})
    reload_ui(); nav("Dorms"); time.sleep(0.8); click_text("button.it", "in the deco room"); time.sleep(1.5)
    check("the chat's header shows the room's tag", d.execute_script("const t=document.querySelector('.chathead .srv-tag');return !!t && t.textContent.includes('INN')"))
    st_ = invoke("get_settings"); st_["deco"] = dict(st_["deco"], plate="embers", wreath="catears", tag="zen", tag_color="#23a55a"); invoke("save_settings", {"settings": st_})
    reload_ui(); nav("Rooms"); time.sleep(1.0)   # (the page has to hear about the settings that were just saved behind its back)
    d.execute_script("const c=[...document.querySelectorAll('.room-card')].find(x=>x.textContent.includes('Deco room'));[...c.querySelectorAll('button')].find(b=>b.textContent.trim()==='Edit').click()"); time.sleep(1.2)
    d.execute_script("document.querySelector('[data-testid=room-deco-same]').click()"); time.sleep(0.6)
    d.execute_script("[...document.querySelectorAll('button.btn.primary')].find(b=>/Save/.test(b.textContent)).click()"); time.sleep(1.5)
    rd2_ = [x for x in invoke("list_rooms") if x["id"] == rd_["id"]][0]["deco"]
    check("'Same as my profile' gives the room the nameplate, wreath and tag you wear", (rd2_["plate"], rd2_["wreath"], rd2_["tag"], rd2_["tag_color"]) == ("embers", "catears", "ZEN", "#23a55a"), str(rd2_))
    invoke("delete_room", {"id": rd_["id"]})
    st_ = invoke("get_settings"); st_["deco"] = dict(st_["deco"], plate="none", wreath="", tag=""); invoke("save_settings", {"settings": st_})
    set_provider(provider=st0["provider"], openai_base_url=st0["openai_base_url"], openai_model=st0["openai_model"])

    # -- custom emoji and stickers: your own pictures, working everywhere or in one room, and the characters can use them too
    from PIL import Image as _I2
    def mk_png(name, rgb, size=(32, 32)):
        pth = os.path.join(WORK, name); _I2.new("RGB", size, rgb).save(pth); return pth
    def add_em(path, kind, name="", meaning="", room=""):
        return invoke_file("add_emoji", path, {"x-kind": kind, "x-name": name, "x-meaning": meaning, "x-room-id": str(room), "x-file-name": os.path.basename(path)})
    em1 = add_em(mk_png("Party Time.png", (250, 60, 60)), "emoji", meaning="celebrating")
    check("an emoji is made from a picture: its name comes from the file name, cleaned, and the picture is copied into the app", (em1["name"], em1["kind"], em1["room_id"], em1["meaning"]) == ("party_time", "emoji", None, "celebrating") and em1["path"].startswith(DATA) and os.path.exists(em1["path"]), str(em1))
    check("two emoji can't share a name and reach", "already" in (inv_err_file("add_emoji", mk_png("party_time.png", (1, 2, 3)), {"x-kind": "emoji", "x-name": "", "x-meaning": "", "x-room-id": "", "x-file-name": "party_time.png"}) or ""))
    check("only pictures are accepted", "pictures" in (inv_err_file("add_emoji", os.path.join(FIX, "loose.json"), {"x-kind": "emoji", "x-name": "x1", "x-meaning": "", "x-room-id": "", "x-file-name": "loose.json"}) or "") or "Unsupported" in (inv_err_file("add_emoji", os.path.join(FIX, "loose.json"), {"x-kind": "emoji", "x-name": "x1", "x-meaning": "", "x-room-id": "", "x-file-name": "loose.json"}) or ""))
    big_ = os.path.join(WORK, "big.png"); open(big_, "wb").write(os.urandom(600 * 1024))
    check("an emoji can't be bigger than 512 KB", "too big" in (inv_err_file("add_emoji", big_, {"x-kind": "emoji", "x-name": "huge", "x-meaning": "", "x-room-id": "", "x-file-name": "big.png"}) or ""))
    ero_ = invoke("create_room", {"room": dict(room_in, name="Stove room", description="Pots and pans.", owner_kind="self", character_id=None, id=0, created_at=0)})
    st_one = add_em(mk_png("shrug.png", (60, 60, 250), (96, 96)), "sticker", meaning="I don't know")
    st_two = add_em(mk_png("bow.png", (60, 250, 60), (96, 96)), "sticker", meaning="a polite bow", room=ero_["id"])
    em_two = add_em(mk_png("stove.png", (250, 250, 60)), "emoji", meaning="cooking", room=ero_["id"])
    check("a sticker or emoji can be tied to one room", st_two["room_id"] == ero_["id"] and em_two["room_id"] == ero_["id"])
    check("the same name can be used in another room (or everywhere) without a clash", add_em(mk_png("shrug2.png", (9, 9, 9), (96, 96)), "sticker", name="shrug", meaning="the stove room shrug", room=ero_["id"])["room_id"] == ero_["id"])
    check("a room that doesn't exist is refused", "doesn't exist" in (inv_err_file("add_emoji", mk_png("ghost.png", (1, 1, 1)), {"x-kind": "emoji", "x-name": "ghost", "x-meaning": "", "x-room-id": "99999", "x-file-name": "ghost.png"}) or ""))
    ren_ = invoke("update_emoji", {"id": st_one["id"], "name": "Big Shrug!", "meaning": "  not sure  ", "roomId": None})
    check("an emoji can be renamed and its meaning changed", (ren_["name"], ren_["meaning"]) == ("big_shrug", "not sure"), str(ren_))
    invoke("update_emoji", {"id": st_one["id"], "name": "shrug", "meaning": "I don't know", "roomId": None})
    set_provider(provider="openai", openai_base_url="http://127.0.0.1:18999/v1", openai_model="fake-model")
    edorm_ = invoke("create_dorm", {"name": "Stove dorm", "roomId": ero_["id"]}); echat_ = invoke("create_chat", {"dormId": edorm_["id"], "name": "stove chat", "kind": "dm", "characterIds": [dcid]})
    invoke("add_user_message", {"chatId": echat_["id"], "text": "hello"}); gen_and_wait(echat_["id"], ["Yay! ", ":party_time: ", "\n[sticker: bow]"])
    sysE_ = sysprompt()
    check("in a room, the characters are told which emoji and stickers it has (those that work everywhere and the room's own, with their meanings)", ":party_time: (celebrating)" in sysE_ and ":stove: (cooking)" in sysE_ and "[sticker: bow] (a polite bow)" in sysE_ and "[sticker: shrug] (the stove room shrug)" in sysE_, sysE_[-700:])
    check("the room's own wins where the names match (one shrug listed, not two)", sysE_.count("[sticker: shrug]") == 1 and "(I don't know)" not in sysE_)
    edorm2_ = invoke("create_dorm", {"name": "No room dorm", "roomId": None}); echat2_ = invoke("create_chat", {"dormId": edorm2_["id"], "name": "plain chat", "kind": "dm", "characterIds": [dcid]})
    invoke("add_user_message", {"chatId": echat2_["id"], "text": "hello"}); gen_and_wait(echat2_["id"])
    sysP_ = sysprompt()
    check("outside the room they only hear about what works everywhere", ":party_time: (celebrating)" in sysP_ and ":stove:" not in sysP_ and "[sticker: bow]" not in sysP_, sysP_[-500:])
    reload_ui(); nav("Dorms"); time.sleep(0.8); click_text("button.it", "stove chat"); time.sleep(1.8)
    check("a reply that uses :name: and [sticker: name] shows them as pictures", d.execute_script("return !!document.querySelector('.msgs img.emoji[data-emoji=party_time]') && !!document.querySelector('.msgs img.sticker[data-sticker=bow]')"))
    check("a name that isn't in this room stays as plain text", d.execute_script("return !document.querySelector('.msgs img.sticker[data-sticker=nothere]')"))
    d.execute_script("document.querySelector('[data-testid=emoji-button]').click()"); time.sleep(0.6)
    check("the emoji button lists this room's emoji and stickers", d.execute_script("return !!document.querySelector('[data-pick-emoji=stove]') && !!document.querySelector('[data-pick-sticker=bow]') && !!document.querySelector('[data-pick-sticker=shrug]')"))
    d.execute_script("document.querySelector('[data-pick-emoji=stove]').click()"); time.sleep(0.4)
    check("choosing an emoji adds it to the message", ":stove:" in d.execute_script("return document.querySelector('.composer textarea').value"))
    d.execute_script("document.querySelector('[data-testid=emoji-button]').click()"); time.sleep(0.5)
    d.execute_script("document.querySelector('[data-pick-sticker=shrug]').click()"); time.sleep(2.5)
    check("choosing a sticker sends it, and it shows as a picture", any(m["role"] == "user" and "[sticker: shrug]" in m["swipes"][0] for m in invoke("list_messages", {"chatId": echat_["id"]})) and d.execute_script("return !!document.querySelector('.msg.user img.sticker[data-sticker=shrug]')"))
    nav("Settings"); d.execute_script("[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Customization').click()"); time.sleep(0.6)
    d.execute_script("document.querySelector('[data-testid=fold-emoji] summary').click()"); time.sleep(0.8)
    check("Customization has an Emoji & stickers section with a card for each", d.execute_script("return document.querySelectorAll('[data-testid=emoji-tab] [data-emoji-row]').length") == len(invoke("list_emoji")))
    old_ctx = invoke("get_settings")["context_tokens"]
    d.execute_script("const i=document.querySelector('[aria-label=\\'Context size\\'], .card input[type=number]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'3072');i.dispatchEvent(new Event('input',{bubbles:true}))"); time.sleep(1.6)
    check("a Chat setting saves by itself, without the Save button", invoke("get_settings")["context_tokens"] == 3072 and not d.execute_script("return !![...document.querySelectorAll('button')].find(b=>b.textContent==='Save settings'&&!b.disabled)"), str(invoke("get_settings")["context_tokens"]))
    st_ = invoke("get_settings"); st_["context_tokens"] = old_ctx; invoke("save_settings", {"settings": st_})
    inp_ = d.find_element(By.CSS_SELECTOR, "[data-testid=emoji-file-emoji]"); d.execute_script("arguments[0].hidden=false;arguments[0].style.display='block';", inp_)
    n_before_ = len(invoke("list_emoji")); inp_.send_keys(mk_png("from-ui.png", (5, 200, 200))); time.sleep(2.0)
    check("emoji can be added from the tab", len(invoke("list_emoji")) == n_before_ + 1 and any(x["name"] == "from_ui" for x in invoke("list_emoji")))
    invoke("delete_room", {"id": ero_["id"]})
    freed_ = {x["name"]: x["room_id"] for x in invoke("list_emoji")}
    check("deleting a room frees what was tied to it: it works everywhere from then on (nothing is lost)", freed_.get("bow") is None and freed_.get("stove") is None, str(freed_))
    gone_ = em1["path"]
    invoke("delete_emoji", {"id": em1["id"]})
    check("deleting an emoji removes its picture too", not os.path.exists(gone_) and all(x["id"] != em1["id"] for x in invoke("list_emoji")))
    for x_ in invoke("list_emoji"): invoke("delete_emoji", {"id": x_["id"]})
    set_provider(provider=st0["provider"], openai_base_url=st0["openai_base_url"], openai_model=st0["openai_model"])

    # -- a character's gallery: more pictures, tagged with moods; the chat shows the one that fits the reply (or a random one)
    from PIL import Image as _Img
    def png_file(name, rgb):
        pth = os.path.join(WORK, name); _Img.new("RGB", (48, 64), rgb).save(pth); return pth
    gpics = {"happy": png_file("g-happy.png", (240, 200, 40)), "sad": png_file("g-sad.png", (40, 80, 200)), "calm": png_file("g-calm.png", (120, 120, 120))}
    gc = invoke("save_character", {"character": {"card": dict(card0, name="Gal Gallery", first_mes="Hi there!")}}); gid = gc["id"]
    gitems = {}
    for k_, pth in gpics.items():
        res_ = invoke_file("add_gallery_image", pth, {"x-char-id": gid, "x-file-name": k_ + ".png"}); gitems[k_] = res_["gallery"][-1]["id"]
    gnow = invoke("get_character", {"id": gid})
    check("pictures can be added to a character's gallery, each with a file", len(gnow["gallery"]) == 3 and all(os.path.exists(x["path"]) for x in gnow["gallery_paths"]) and len(gnow["gallery_paths"]) == 3, str(gnow["gallery"]))
    check("a gallery doesn't take a 3D model or a text file", "gallery holds" in (inv_err_file("add_gallery_image", os.path.join(FIX, "sample.vrm"), {"x-char-id": gid, "x-file-name": "x.vrm"}) or "") and "Unsupported" in (inv_err_file("add_gallery_image", os.path.join(FIX, "worldinfo_st.json"), {"x-char-id": gid, "x-file-name": "x.txt"}) or ""))
    r1 = invoke("set_gallery_moods", {"id": gid, "itemId": gitems["happy"], "moods": ["happy", "laughing", "bogus", "happy"]})
    check("moods are saved once each, and unknown ones are ignored", [g["moods"] for g in r1["gallery"] if g["id"] == gitems["happy"]] == [["happy", "laughing"]])
    invoke("set_gallery_moods", {"id": gid, "itemId": gitems["sad"], "moods": ["sad"]}); invoke("set_gallery_moods", {"id": gid, "itemId": gitems["calm"], "moods": ["neutral"]})
    check("only the known modes are accepted", "Unknown" in (inv_err("set_gallery_mode", {"id": gid, "mode": "chaos"}) or "") and invoke("set_gallery_mode", {"id": gid, "mode": "mood"})["gallery_mode"] == "mood")
    stale = invoke("save_character", {"character": dict(gc, card=dict(gc["card"], description="edited in the editor"))})
    check("saving the character from an old copy keeps its gallery and mode", len(stale["gallery"]) == 3 and stale["gallery_mode"] == "mood" and stale["card"]["description"] == "edited in the editor")
    set_provider(provider="openai", openai_base_url="http://127.0.0.1:18999/v1", openai_model="fake-model")
    gchat = invoke("create_chat", {"dormId": None, "name": "Gal chat", "kind": "dm", "characterIds": [gid]})
    reload_ui(); nav("Dorms"); time.sleep(1.0)
    d.find_element(By.XPATH, "//button[contains(@class,'it') and contains(., 'Gal chat')]").click(); time.sleep(1.0)
    last_avatar = lambda: d.execute_script("const a=[...document.querySelectorAll('.msgs .msg:not(.user) .avatar img')];return a.length?decodeURIComponent(a[a.length-1].src):''")
    stage_img = lambda: d.execute_script("const i=document.querySelector('.stage img');return i?decodeURIComponent(i.src):''")
    check("before any reply the main picture is shown (no gallery picture yet)", not any(v in last_avatar() for v in gitems.values()))
    def say_and_wait(text, pieces):
        seen["pieces"] = pieces
        n0 = len([x for x in invoke("list_messages", {"chatId": gchat["id"]}) if x["role"] == "character"])
        box_ = d.find_element(By.CSS_SELECTOR, ".composer textarea"); box_.send_keys(text); box_.send_keys(Keys.ENTER)
        for _ in range(40):
            time.sleep(0.5)
            if len([x for x in invoke("list_messages", {"chatId": gchat["id"]}) if x["role"] == "character"]) > n0: break
        time.sleep(0.8)
    say_and_wait("tell me a joke", ["*smiles and laughs* ", "Haha, ", "that's a good one!"])
    check("a happy, laughing reply shows the picture tagged for it, on the message and the stage", gitems["happy"] in last_avatar() and gitems["happy"] in stage_img(), f"{last_avatar()} | {stage_img()}")
    say_and_wait("what's wrong?", ["*tears run down her cheeks* ", "I miss them so much."])
    check("a sad reply shows the sad picture", gitems["sad"] in last_avatar() and gitems["sad"] in stage_img(), f"{last_avatar()} | {stage_img()}")
    say_and_wait("what time is it?", ["It is nine o'clock ", "and the shop is closed."])
    check("a reply with no particular mood falls back to the picture tagged neutral", gitems["calm"] in last_avatar(), last_avatar())
    check("the last reply offers Write a novel next to Regenerate and Continue", d.execute_script("return !!document.querySelector('[data-testid=novel-open]')"))
    d.execute_script("document.querySelector('[data-testid=novel-open]').click()"); time.sleep(0.8)
    check("it asks what story to write, and how it fits the allowance, before writing anything", d.execute_script("return !!document.querySelector('[data-testid=novel-plot]') && document.querySelector('[data-testid=novel-estimate]').innerText.includes('One request to your model per chapter') && !!document.querySelector('[data-testid=novel-start]')"), page_text()[-400:])
    dismiss(); time.sleep(0.4)
    check("earlier messages keep the picture they had (this character has no main picture, so only the latest message wears a picture)", d.execute_script("return document.querySelectorAll('.msgs .msg:not(.user)').length>=4 && document.querySelectorAll('.msgs .msg:not(.user) .avatar img').length===1"))
    reload_ui(); nav("Dorms"); time.sleep(1.0)
    d.find_element(By.XPATH, "//button[contains(@class,'it') and contains(., 'Gal chat')]").click(); time.sleep(1.0)
    check("the picture is remembered when the chat is opened again", gitems["calm"] in last_avatar(), last_avatar())
    invoke("set_gallery_mode", {"id": gid, "mode": "random"}); reload_ui(); nav("Dorms"); time.sleep(1.0)
    d.find_element(By.XPATH, "//button[contains(@class,'it') and contains(., 'Gal chat')]").click(); time.sleep(1.0)
    shown = set()
    for i_ in range(5):
        say_and_wait(f"again {i_}", ["Just a plain reply ", str(i_)])
        shown.add(next((k_ for k_, v in gitems.items() if v in last_avatar()), "main"))
    check("in random mode the picture changes between replies (and stays inside the gallery)", len(shown) >= 2 and "main" not in shown, str(shown))
    invoke("set_gallery_mode", {"id": gid, "mode": "fixed"}); reload_ui(); nav("Dorms"); time.sleep(1.0)
    d.find_element(By.XPATH, "//button[contains(@class,'it') and contains(., 'Gal chat')]").click(); time.sleep(1.0)
    say_and_wait("and now?", ["*laughs out loud* ", "Hahaha!"])
    check("with the main picture kept, no gallery picture is shown", not any(v in last_avatar() for v in gitems.values()) and not any(v in stage_img() for v in gitems.values()))
    seen["pieces"] = None
    removed = invoke("remove_gallery_item", {"id": gid, "itemId": gitems["sad"]})
    check("a picture can be removed (its file goes too)", len(removed["gallery"]) == 2 and not any(f.startswith(gid + "-gal-" + gitems["sad"]) for f in os.listdir(os.path.join(DATA, "media"))))
    set_provider(provider=st0["provider"], openai_base_url=st0["openai_base_url"], openai_model=st0["openai_model"])

    # the walls between the panels can be dragged (left mouse button), double-click puts them back
    reload_ui(); nav("Characters"); time.sleep(1.0)
    drag_wall = """
      const w = document.querySelector('.resizer.' + arguments[0]); const x = arguments[1];
      w.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, button: 0, clientX: 0, pointerId: 1}));
      window.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, clientX: x, pointerId: 1}));
      window.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, clientX: x, pointerId: 1}));"""
    var = lambda n: d.execute_script("return getComputedStyle(document.querySelector('.shell')).getPropertyValue(arguments[0]).trim()", n)
    width_of = lambda sel: d.execute_script("return Math.round(document.querySelector(arguments[0]).getBoundingClientRect().width)", sel)
    d.execute_script(drag_wall, "left", 330); time.sleep(0.4)
    check("dragging the wall by the side bar makes the side bar wider", var("--side-w") == "330px" and abs(width_of("nav.side") - 330) <= 2, f"{var('--side-w')} {width_of('nav.side')}")
    win_w = d.execute_script("return window.innerWidth")
    d.execute_script(drag_wall, "right", win_w - 350); time.sleep(0.4)
    check("dragging the wall by the characters list resizes it too", var("--members-w") == "350px" and abs(width_of(".members") - 350) <= 2, f"{var('--members-w')} {width_of('.members')}")
    d.execute_script(drag_wall, "left", 5); time.sleep(0.3)
    check("a panel can't be dragged narrower than its minimum", var("--side-w") == "160px")
    reload_ui(); nav("Characters"); time.sleep(1.0)
    check("the widths are remembered after a restart", var("--side-w") == "160px" and var("--members-w") == "350px")
    for side_ in ("left", "right"): d.execute_script("document.querySelector('.resizer.' + arguments[0]).dispatchEvent(new MouseEvent('dblclick', {bubbles: true}))", side_)
    time.sleep(0.4)
    check("double-clicking a wall puts the panel back to its normal width", var("--side-w") == "220px" and var("--members-w") == "264px")
    d.execute_script("document.querySelector('[aria-label=\"Hide the characters list\"]').click()"); time.sleep(0.5)
    check("the characters list can be hidden, and a small tab brings it back", not d.execute_script("return !!document.querySelector('.members')") and d.execute_script("return !!document.querySelector('.members-tab')"))

    # the side bar's items can be dragged into your own order; Prompts stays last
    # the label is the text of the button itself (its icon sits in a span of its own)
    labels = lambda: d.execute_script("return [...document.querySelectorAll('nav.side button.nav[data-nav]')].map(b=>[...b.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim())")
    order0 = labels()
    check("the side bar starts in its normal order, with Tokenator at the top and Prompts after them", order0[:2] == ["Tokenator", "Home"] and order0[-1] == "Settings" and d.execute_script("return document.querySelector('nav.side .prompts').previousElementSibling.dataset.nav") == "settings")
    drag_nav = """
      const a = document.querySelector('[data-nav=' + arguments[0] + ']'), b = document.querySelector('[data-nav=' + arguments[1] + ']');
      const r = b.getBoundingClientRect(); const y = arguments[2] ? r.bottom - 2 : r.top + 2; const dt = new DataTransfer();
      a.dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: dt}));
      b.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 5, clientY: y}));
      b.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 5, clientY: y}));
      a.dispatchEvent(new DragEvent('dragend', {bubbles: true, dataTransfer: dt}));"""
    d.execute_script(drag_nav, "notes", "tokenator", False); time.sleep(0.5)
    check("dropping an item on the top half of another puts it before that one", labels()[0] == "Notes" and labels()[1] == "Tokenator", str(labels()))
    d.execute_script(drag_nav, "home", "settings", True); time.sleep(0.5)
    check("dropping on the bottom half puts it after, and Prompts is still last", labels()[-1] == "Home" and d.execute_script("const ps=document.querySelector('nav.side .prompts');return [...document.querySelectorAll('nav.side button.nav[data-nav]')].every(b=>b.compareDocumentPosition(ps)&Node.DOCUMENT_POSITION_FOLLOWING)"), str(labels()))
    check("Prompts can't be dragged", d.execute_script("return document.querySelector('[data-testid=prompts-toggle]').getAttribute('draggable')") is None)
    reload_ui(); time.sleep(0.8)
    check("the order is remembered after a restart", labels()[0] == "Notes" and labels()[-1] == "Home", str(labels()))
    d.execute_script("document.querySelector('[data-nav=notes]').focus()")
    ActionChains(d).key_down(Keys.ALT).send_keys(Keys.ARROW_DOWN).key_up(Keys.ALT).perform(); time.sleep(0.5)
    check("Alt and the down arrow moves the focused item down one place", labels()[:2] == ["Tokenator", "Notes"], str(labels()))
    nav("Settings"); time.sleep(0.6); click_text("button[role=tab]", "Customization"); time.sleep(0.6)
    click_text("button", "Reset the side bar order"); time.sleep(0.5)
    check("the order can be reset from Settings, Appearance", labels() == order0, str(labels()))
    d.execute_script("localStorage.setItem('dorms.nav.order', JSON.stringify(['settings','home','lorebooks','notes','rooms','chat','decor','library','playbooks']))"); reload_ui(); time.sleep(0.8)
    check("for someone who already arranged their side bar, Tokenator appears at the top, the Gallery right after Characters, and their order is kept", labels()[0] == "Tokenator" and labels()[1:] == ["Settings", "Home", "Lorebooks", "Notes", "Rooms", "Dorms", "Decorations", "Characters", "Gallery", "Playbooks"], str(labels()))
    d.execute_script(drag_nav, "tokenator", "home", True); time.sleep(0.5)
    reload_ui(); time.sleep(0.8)
    check("Tokenator can be moved like any other item, and the place is remembered", labels()[:3] == ["Settings", "Home", "Tokenator"], str(labels()))
    d.execute_script("localStorage.removeItem('dorms.nav.order')"); reload_ui(); time.sleep(0.6)

    # -- side bar extras: recent chats, favorites (as many as you like), most used, and a picture frame
    all_chars = invoke("list_characters")
    extra_ids = []
    while len(all_chars) + len(extra_ids) < 13:
        extra_ids.append(invoke("save_character", {"character": {"card": dict(card0, name=f"Fave {len(extra_ids)}", first_mes="Hi!")}})["id"])
    all_chars = invoke("list_characters")
    orig_fav = {c_["id"]: c_["favorite"] for c_ in all_chars}
    for c_ in all_chars: invoke("set_favorite", {"id": c_["id"], "favorite": False})
    reload_ui(); nav("Characters"); time.sleep(1.2)
    chats_sorted = sorted(invoke("list_chats"), key=lambda c: -c["updated_at"])
    rows_ = d.execute_script("return [...document.querySelectorAll('[data-testid=side-recent] .sw-row')].map(r=>Number(r.dataset.chat))")
    check("Recent chats lists the latest five, newest first", len(chats_sorted) >= 2 and rows_ == [c["id"] for c in chats_sorted[:5]], f"{rows_} vs {[c['id'] for c in chats_sorted[:5]]}")
    check("with no favorites chosen the Favorites section says how to add some", d.execute_script("return document.querySelector('[data-testid=side-favorites]').innerText.includes('no limit')"))
    for c_ in all_chars: invoke("set_favorite", {"id": c_["id"], "favorite": True})
    reload_ui(); nav("Characters"); time.sleep(1.2)
    n_fav = d.execute_script("return document.querySelectorAll('[data-testid=side-favorites] .sw-fave').length")
    check("every favorite is in the side bar, however many there are (no limit)", n_fav == len(all_chars) and n_fav > 10, f"{n_fav} of {len(all_chars)}")
    d.execute_script("document.querySelector('[aria-label=\"Choose favorite characters\"]').click()"); time.sleep(0.6)
    one = d.execute_script("return document.querySelector('[data-pickfav]').dataset.pickfav")
    check("the Favorites picker lists everyone, ticked", d.execute_script("return document.querySelectorAll('[data-pickfav] input:checked').length") == len(all_chars))
    d.execute_script("document.querySelector('[data-pickfav] input').click()"); time.sleep(0.8)
    check("unticking someone removes them from the favorites", len([c_ for c_ in invoke("list_characters") if c_["favorite"]]) == len(all_chars) - 1)
    d.execute_script("document.querySelector('.modal button.btn.primary').click()"); time.sleep(0.5)
    usage = invoke("character_usage")
    check("the most used ranking counts each character's messages, most first", len(usage) >= 1 and all(usage[i]["messages"] >= usage[i + 1]["messages"] for i in range(len(usage) - 1)), str(usage[:3]))
    top_n = usage[0]["messages"]
    first_used = d.execute_script("const r=document.querySelector('[data-testid=side-usage] .sw-row small');return r?r.textContent:''")
    check("the Most used section shows the top character with their message count", first_used == f"{top_n:,} message{'s' if top_n != 1 else ''}", first_used)
    fr = d.execute_script("const f=document.querySelector('[data-testid=side-frame-link]');return f?f.dataset.frame:''")
    check("the picture frame shows a character with a plaque", bool(fr) and d.execute_script("return !!document.querySelector('[data-testid=side-frame-link] .sw-plaque')"))
    d.execute_script("document.querySelector('[data-testid=side-frame-link]').click()"); time.sleep(1.2)
    check("clicking the picture frame opens the latest chat", d.execute_script("return document.querySelector('.chathead h3')?.textContent||''").endswith(chats_sorted[0]["name"]), d.execute_script("return document.querySelector('.chathead h3')?.textContent||''"))
    # the frame can be given to one character, who stays until the user changes it (not just the latest chat)
    nav("Characters"); time.sleep(0.6)
    frame_name = lambda: d.execute_script("const f=document.querySelector('[data-testid=side-frame-link]');return f?f.dataset.frame+'|'+f.dataset.framed:''")
    check("with nobody chosen the frame follows the latest chat", frame_name() == fr + "|auto", frame_name())
    d.execute_script("document.querySelector('[aria-label=\"Choose who hangs in the picture frame\"]').click()"); time.sleep(0.6)
    other_fr = d.execute_script("const n=[...document.querySelectorAll('[data-pickframe]')].map(x=>x.dataset.pickframe).filter(x=>x!=='auto'&&x!==arguments[0]);return n[0]||''", fr)
    check("the frame has a chooser listing the characters", bool(other_fr) and d.execute_script("return !!document.querySelector('[data-pickframe=auto]')"), other_fr)
    d.execute_script("const l=[...document.querySelectorAll('[data-pickframe]')].find(x=>x.dataset.pickframe===arguments[0]);l.querySelector('input').click()", other_fr); time.sleep(0.8)
    check("the chosen character now hangs in the frame", frame_name() == other_fr + "|chosen", frame_name())
    reload_ui(); nav("Characters"); time.sleep(1.2)
    check("and stays there after the app is reopened, whatever the latest chat is", frame_name() == other_fr + "|chosen", frame_name())
    d.execute_script("document.querySelector('[data-testid=side-frame-link]').click()"); time.sleep(1.5)
    check("clicking the frame opens a chat with the chosen character", other_fr in d.execute_script("return document.querySelector('.chathead .tok')?.textContent||''"), d.execute_script("return document.querySelector('.chathead .tok')?.textContent||''"))
    nav("Characters"); time.sleep(0.6)
    d.execute_script("document.querySelector('[aria-label=\"Choose who hangs in the picture frame\"]').click()"); time.sleep(0.6)
    d.execute_script("document.querySelector('[data-pickframe=auto] input').click()"); time.sleep(0.8)
    check("the choice can be undone (back to whoever was talked to last)", frame_name().endswith("|auto"), frame_name())
    # more frames: arrows in the gaps either side, each frame with its own character
    first_ = frame_name()
    check("the frame has an arrow in its gap on each side", d.execute_script("return !!document.querySelector('[data-testid=frame-left]') && !!document.querySelector('[data-testid=frame-right]')"))
    d.execute_script("document.querySelector('[data-testid=frame-right]').click()"); time.sleep(0.8)
    check("the right arrow opens another frame, and asks who hangs in it", d.execute_script("return !!document.querySelector('[data-pickframe]') && document.querySelector('.modal').innerText.includes('frame 2 of 2')"))
    other2_ = d.execute_script("const n=[...document.querySelectorAll('[data-pickframe]')].map(x=>x.dataset.pickframe).filter(x=>x!=='auto'&&x!==arguments[0].split('|')[0]);return n[0]||''", first_)
    d.execute_script("const l=[...document.querySelectorAll('[data-pickframe]')].find(x=>x.dataset.pickframe===arguments[0]);l.querySelector('input').click()", other2_); time.sleep(0.8)
    check("the new frame holds the character chosen for it, and says which frame it is", frame_name().startswith(other2_ + "|") and d.execute_script("return document.querySelector('[data-testid=frame-count]').textContent") == "2 of 2", frame_name())
    d.execute_script("document.querySelector('[data-testid=frame-left]').click()"); time.sleep(0.6)
    check("the left arrow flips back to the first frame, still as it was", frame_name() == first_ and d.execute_script("return document.querySelector('[data-testid=frame-count]').textContent") == "1 of 2", frame_name())
    reload_ui(); time.sleep(0.6)
    check("the frames are kept", d.execute_script("const e=document.querySelector('[data-frames]');return !!e && e.dataset.frames==='2'"))
    d.execute_script("document.querySelector('[data-testid=frame-right]').click()"); time.sleep(0.5)
    d.execute_script("document.querySelector('[aria-label=\"Choose who hangs in the picture frame\"]').click()"); time.sleep(0.5)
    d.execute_script("document.querySelector('[data-testid=frame-remove]').click()"); time.sleep(0.6)
    check("a frame can be taken down, leaving the other", d.execute_script("const e=document.querySelector('[data-frames]');return !!e && e.dataset.frames==='1'") and frame_name() == first_, frame_name())
    chats_sorted = sorted(invoke("list_chats"), key=lambda c: -c["updated_at"])  # opening the chosen character's chat may have made a newer one
    nav("Characters"); time.sleep(0.6)
    d.execute_script("document.querySelector('[data-testid=side-recent] .sw-row').click()"); time.sleep(1.0)
    check("clicking a recent chat opens it", d.execute_script("return document.querySelector('.chathead h3')?.textContent||''").endswith(chats_sorted[0]["name"]))
    fave_name = d.execute_script("const f=document.querySelector('[data-testid=side-favorites] .sw-fave');return f.dataset.fave")
    d.execute_script("document.querySelector('[data-testid=side-favorites] .sw-fave').click()"); 
    head_ = lambda: d.execute_script("return document.querySelector('.chathead .tok')?.textContent||''")
    for _ in range(20):
        time.sleep(0.5)
        if fave_name in head_(): break
    toasts_ = d.execute_script("return [...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' | ')")
    check("clicking a favorite opens a chat with them", fave_name in head_(), f"{fave_name!r} vs {head_()!r}; toasts: {toasts_!r}; chats: {len(invoke('list_chats'))}")
    nav("Characters"); time.sleep(0.5)
    d.execute_script("document.querySelector('[data-testid=side-recent] .sw-title').click()"); time.sleep(0.4)
    check("a section can be folded away", not d.execute_script("return !!document.querySelector('[data-testid=side-recent] .sw-body')"))
    d.execute_script("document.querySelector('[data-testid=side-recent] .sw-title').click()"); time.sleep(0.3)
    # the sections can be renamed at any time (recent chats, favorites, most used and the picture frame)
    title_of = lambda sid: d.execute_script("const t=document.querySelector('[data-testid=side-%s] .sw-title');return t?t.textContent.replace(/\\d+$/,'').replace(/^[^A-Za-z]+/,'').trim():''" % sid)
    check("the sections start with their usual names", [title_of(x) for x in ("recent", "favorites", "usage", "frame")] == ["Recent chats", "Favorites", "Most used", "Picture frame"], str([title_of(x) for x in ("recent", "favorites", "usage", "frame")]))
    for sid, new in [("recent", "Jump back in"), ("favorites", "My people"), ("usage", "Regulars"), ("frame", "Memory wall")]:
        d.execute_script("document.querySelector('[data-testid=side-%s-rename]').click()" % sid); time.sleep(0.3)
        set_value("[data-testid=side-%s-name]" % sid, new); d.find_element(By.CSS_SELECTOR, "[data-testid=side-%s-name]" % sid).send_keys(Keys.ENTER); time.sleep(0.4)
    check("each section can be given another name", [title_of(x) for x in ("recent", "favorites", "usage", "frame")] == ["Jump back in", "My people", "Regulars", "Memory wall"], str([title_of(x) for x in ("recent", "favorites", "usage", "frame")]))
    reload_ui(); time.sleep(0.6)
    check("the new names are kept", [title_of(x) for x in ("recent", "favorites", "usage", "frame")] == ["Jump back in", "My people", "Regulars", "Memory wall"])
    d.execute_script("document.querySelector('[data-testid=side-recent-rename]').click()"); time.sleep(0.3)
    set_value("[data-testid=side-recent-name]", "x" * 60); d.find_element(By.CSS_SELECTOR, "[data-testid=side-recent-name]").send_keys(Keys.ENTER); time.sleep(0.4)
    check("a name is limited to 24 characters", title_of("recent") == "x" * 24, title_of("recent"))
    d.execute_script("document.querySelector('[data-testid=side-recent-rename]').click()"); time.sleep(0.3)
    set_value("[data-testid=side-recent-name]", "   "); d.find_element(By.CSS_SELECTOR, "[data-testid=side-recent-name]").send_keys(Keys.ENTER); time.sleep(0.4)
    check("an empty name goes back to the usual one", title_of("recent") == "Recent chats", title_of("recent"))
    nav("Settings"); click_text("button[role=tab]", "Customization"); time.sleep(0.6)
    check("Settings shows each name, to change or clear", d.execute_script("return document.querySelector('[data-testid=name-frame]').value") == "Memory wall" and d.execute_script("return document.querySelector('[data-testid=name-recent]').value") == "")
    click_text("button", "Use the usual names"); time.sleep(0.6)
    check("'Use the usual names' puts them all back", [title_of(x) for x in ("recent", "favorites", "usage", "frame")] == ["Recent chats", "Favorites", "Most used", "Picture frame"], str([title_of(x) for x in ("recent", "favorites", "usage", "frame")]))
    nav("Dorms"); time.sleep(0.5)

    nav("Settings"); time.sleep(0.6); click_text("button[role=tab]", "Customization"); time.sleep(0.6)
    d.execute_script("document.querySelector('[data-widget=frame]').click()"); time.sleep(0.5)
    check("a side bar extra can be switched off in Settings (and back on)", not d.execute_script("return !!document.querySelector('[data-testid=side-frame]')") and d.execute_script("document.querySelector('[data-widget=frame]').click(); return true") and d.execute_script("return !!document.querySelector('[data-testid=side-frame]')"))
    for c_ in all_chars: invoke("set_favorite", {"id": c_["id"], "favorite": orig_fav.get(c_["id"], False)})
    for i_ in extra_ids: invoke("delete_character", {"id": i_})

    # -- text size in chats: a slider that makes the roleplay text bigger, kept on this device
    nav("Settings"); time.sleep(0.6); click_text("button[role=tab]", "Customization"); time.sleep(0.6)
    px = lambda: float(d.execute_script("return parseFloat(getComputedStyle(document.querySelector('[data-testid=text-size-sample] .txt')).fontSize)"))
    base_px = px()
    check("Appearance has a text size slider, at 100% to start", text_present("Text size in chats") and d.execute_script("return document.querySelector('[data-testid=text-size-value]').textContent") == "100%" and 14 <= base_px <= 20, str(base_px))
    set_value("input[aria-label='Text size']", "150"); time.sleep(0.4)
    check("moving it makes the sample text bigger right away", abs(px() / base_px - 1.5) < 0.02 and d.execute_script("return document.querySelector('[data-testid=text-size-value]').textContent") == "150%", f"{base_px} -> {px()}")
    check("the size is applied to the whole app (chats read it)", d.execute_script("return getComputedStyle(document.documentElement).getPropertyValue('--chat-scale').trim()") == "1.5")
    reload_ui(); nav("Settings"); time.sleep(0.6); click_text("button[role=tab]", "Customization"); time.sleep(0.6)
    check("it is remembered after a restart", d.execute_script("return document.querySelector('[data-testid=text-size-value]').textContent") == "150%" and abs(px() / base_px - 1.5) < 0.02)
    click_exact("button", "Reset"); time.sleep(0.4)
    check("Reset puts it back to normal", d.execute_script("return document.querySelector('[data-testid=text-size-value]').textContent") == "100%" and abs(px() - base_px) < 0.5)
    set_value("input[aria-label='Text size']", "300"); time.sleep(0.3)
    check("it can't go past 200%", d.execute_script("return document.querySelector('[data-testid=text-size-value]').textContent") == "200%")
    click_exact("button", "Reset"); time.sleep(0.3)

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
        # the text size slider inside a live chat: the text reacts as the slider moves, and the size is shown
        msgs_px = lambda: float(d.execute_script("return parseFloat(getComputedStyle(document.querySelector('.msgs')).fontSize)"))
        base_msgs = msgs_px()
        check("the chat has its own text size slider", d.execute_script("return !!document.querySelector('.chathead .textsize input[aria-label=\\'Text size\\']')") and d.execute_script("return document.querySelector('[data-testid=text-size-pct]').textContent") == "100%")
        set_value("input[aria-label='Text size']", "150"); time.sleep(0.7)
        check("moving it makes the chat text bigger right away, and the size is shown", abs(msgs_px() / base_msgs - 1.5) < 0.03 and d.execute_script("return document.querySelector('[data-testid=text-size-pct]').textContent") == "150%" and d.execute_script("return !!document.querySelector('.size-flash')"), f"{base_msgs} -> {msgs_px()}")
        set_value("input[aria-label='Text size']", "90"); time.sleep(0.7)
        check("and smaller again just as quickly", abs(msgs_px() / base_msgs - 0.9) < 0.03, f"{base_msgs} -> {msgs_px()}")
        set_value("input[aria-label='Text size']", "100"); time.sleep(0.5)
        # saved prompts: a drop-down in the side bar that doesn't leave the chat; click puts one in the message box, dragging one into the chat sends it
        sp = invoke("save_prompt", {"prompt": {"id": "", "title": "Soft redirect", "body": "[OOC: please keep the scene gentle.]", "tag": "Style", "created_at": 0, "updated_at": 0}})
        check("a prompt is saved with its title, text and label", sp["id"] and sp["title"] == "Soft redirect" and sp["tag"] == "Style" and [p["title"] for p in invoke("list_prompts")] == ["Soft redirect"], str(sp))
        d.execute_script("document.querySelector('[data-testid=prompts-toggle]').click()"); time.sleep(0.8)
        check("the Prompts drop-down opens in the side bar and the chat stays open", d.execute_script("return !!document.querySelector('[data-testid=prompts-panel] [data-prompt=\"Soft redirect\"]') && !!document.querySelector('.chatmain') && !!document.querySelector('.composer')"))
        d.execute_script("document.querySelector('[data-prompt=\"Soft redirect\"]').click()"); time.sleep(0.5)
        check("clicking a prompt puts it in the message box (not sent)", d.execute_script("return document.querySelector('.composer textarea').value") == "[OOC: please keep the scene gentle.]")
        n_msgs = d.execute_script("return document.querySelectorAll('.msgs .msg').length")
        drop_prompt = """
          const t = document.querySelector('.chatmain'); const dt = new DataTransfer();
          dt.setData('application/x-dorms-prompt', JSON.stringify({title: 'x', body: arguments[0]}));
          t.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: dt}));
          t.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: dt}));"""
        d.execute_script(drop_prompt, "[OOC: slow down a little.]"); time.sleep(1.2)
        check("dropping a prompt on the chat while something is typed adds it to the message box instead of sending", d.execute_script("return document.querySelector('.composer textarea').value") == "[OOC: slow down a little.]\n\n[OOC: please keep the scene gentle.]" and d.execute_script("return document.querySelectorAll('.msgs .msg').length") == n_msgs)
        set_value(".composer textarea", ""); time.sleep(0.3)
        d.execute_script(drop_prompt, "[OOC: time skip to the evening.]")
        for _ in range(20):
            time.sleep(0.5)
            if "time skip to the evening" in d.execute_script("return document.querySelector('.msgs').innerText"): break
        check("dropping a prompt on the chat with nothing typed sends it as a message at once", "time skip to the evening" in d.execute_script("return document.querySelector('.msgs').innerText"))
        h0_ = d.execute_script("return document.querySelector('[data-testid=prompts-panel]').offsetHeight")
        d.execute_script("const g=document.querySelector('[data-testid=drawer-pull]');g.focus();for(let i=0;i<3;i++)g.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))"); time.sleep(0.5)
        h1_ = d.execute_script("const p=document.querySelector('[data-testid=prompts-panel]');return [p.offsetHeight, p.classList.contains('pulled'), getComputedStyle(p).position, getComputedStyle(p).zIndex]")
        check("pulling the drawer down makes the prompt list taller and lets it float over what is below", h1_[0] > h0_ and h1_[1] is True and h1_[2] == "absolute" and int(h1_[3]) >= 40, f"{h0_} {h1_}")
        w0_ = d.execute_script("return document.querySelector('[data-testid=prompts-panel]').offsetWidth")
        d.execute_script("const g=document.querySelector('[data-testid=drawer-edge]');g.focus();for(let i=0;i<3;i++)g.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))"); time.sleep(0.5)
        check("the drawer can be stretched to the right", d.execute_script("return document.querySelector('[data-testid=prompts-panel]').offsetWidth") > w0_)
        d.execute_script("document.querySelector('[data-testid=drawer-pull]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))"); time.sleep(0.5)
        check("double-clicking the handle draws the drawer back in", d.execute_script("const p=document.querySelector('[data-testid=prompts-panel]');return !p.classList.contains('pulled') && p.offsetHeight===arguments[0]", h0_))
        n_pr_ = len(invoke("list_prompts"))
        seen["pieces"] = ["TITLE: Gentle brakes\nLABEL: Pace\nTEXT:\nLet's slow down for a moment."]
        d.execute_script("document.querySelector('[data-testid=prompt-ask-tokenator]').click()"); time.sleep(0.8)
        check("the Prompts drawer has a Tokenator button that opens the editor with the helper ready", d.execute_script("return !!document.querySelector('[data-testid=tokenator-helper-prompt] [data-testid=tokenator-make-notes]')"))
        set_value("[data-testid=tokenator-make-notes]", "a gentle way to slow things down"); time.sleep(0.3)
        d.execute_script("document.querySelector('[data-testid=tokenator-make-go]').click()"); time.sleep(2.5)
        check("the draft is shown first, and nothing is filled in or saved yet", d.execute_script("const t=document.querySelector('[data-testid=tokenator-make-title]');return !!t && t.textContent==='Gentle brakes'") and d.execute_script("return document.querySelector(\"input[aria-label='Prompt title']\").value===''") and len(invoke("list_prompts")) == n_pr_)
        d.execute_script("document.querySelector('[data-testid=tokenator-make-accept]').click()"); time.sleep(1.0)
        time.sleep(0.8)
        made_ = [x for x in invoke("list_prompts") if x["title"] == "Gentle brakes"]
        check("accepting puts the prompt straight into Prompts, saved, with its title, label and text", len(made_) == 1 and made_[0]["tag"] == "Pace" and "slow down for a moment" in made_[0]["body"] and len(invoke("list_prompts")) == n_pr_ + 1, str(made_))
        check("and closes the editor", d.execute_script("return !document.querySelector(\"input[aria-label='Prompt title']\")"))
        for x_ in made_: invoke("delete_prompt", {"id": x_["id"]})
        seen["pieces"] = None
        d.execute_script("document.querySelector('[data-testid=prompts-toggle]').click()"); time.sleep(0.3)
        check("the drop-down closes again", not d.execute_script("return !!document.querySelector('[data-testid=prompts-panel]')"))
        check("a prompt needs a title and some text", "title" in (inv_err("save_prompt", {"prompt": {"id": "", "title": " ", "body": "x", "tag": "", "created_at": 0, "updated_at": 0}}) or "") and "no text" in (inv_err("save_prompt", {"prompt": {"id": "", "title": "T", "body": "  ", "tag": "", "created_at": 0, "updated_at": 0}}) or ""))
        sp2 = invoke("save_prompt", {"prompt": dict(sp, title="Gentle redirect", body="[OOC: gentle.]")})
        check("saving again with its id edits the prompt", sp2["id"] == sp["id"] and [p["title"] for p in invoke("list_prompts")] == ["Gentle redirect"] and sp2["created_at"] == sp["created_at"])
        invoke("save_prompt", {"prompt": {"id": "", "title": "Keep for export", "body": "[OOC: export me.]", "tag": "", "created_at": 0, "updated_at": 0}})
        invoke("delete_prompt", {"id": sp["id"]})
        check("a prompt can be deleted", [p["title"] for p in invoke("list_prompts")] == ["Keep for export"])
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
    out = invoke("hide_profile")
    check("hiding an account closes it, takes it off the start screen's list and lists it as hidden", out["signed_in"] is False and all(p["handle"] != "Alex" for p in out["profiles"]) and [p["handle"] for p in out["hidden_profiles"]] == ["Alex"], str(out)[:300])
    check("showing a hidden account that has a passcode needs the passcode", "wrong passcode" in (inv_err("unhide_profile", {"profileId": alex_id, "passcode": "nope"}) or "").lower())
    out = invoke("unhide_profile", {"profileId": alex_id, "passcode": "open sesame"})
    check("with the passcode it is on the list again, and nothing was lost", any(p["handle"] == "Alex" for p in out["profiles"]) and out["hidden_profiles"] == [])
    invoke("sign_in", {"profileId": None})
    check("the guest space can't be hidden", "guest" in (inv_err("hide_profile") or "").lower())
    invoke("sign_in", {"profileId": alex_id, "passcode": "open sesame"})
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
    nav("Settings"); d.execute_script("[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Profiles').click()"); time.sleep(0.8)
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
    check("a model has to be a .glb, .gltf or .fbx", "glb" in (inv_err_file("set_room_model", glb, {"x-room-id": str(pub["id"]), "x-file-name": "house.txt"}) or ""))
    check("a .unitypackage isn't sent as a model: it is opened from the room form", "3D model field" in (inv_err_file("set_room_model", glb, {"x-room-id": str(pub["id"]), "x-file-name": "house.unitypackage"}) or ""))
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
    ex = invoke("room_package_extract", {"token": tk, "modelGuids": [rep["models"][0]["guid"]]})
    check("the chosen model is unpacked into a file the app can read", len(ex["models"]) == 1 and ex["models"][0]["ext"] == "glb" and os.path.getsize(ex["models"][0]["file"]) == os.path.getsize(glb), str(ex))
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

    # -- decorations: a library of props from a package, with a sharing mark on each
    pk_pack = os.path.join(WORK, "props.unitypackage")
    gb = open(glb, "rb").read()
    mkpkg(pk_pack, [(g("1"), "Assets/Props/Lamp.glb", gb), (g("2"), "Assets/Props/Plant.glb", gb), (g("3"), "Assets/Props/Table.glb", gb), (g("4"), "Assets/Props/Cafe.blend", b"BLENDER")])
    nav("Decorations"); time.sleep(0.6)
    check("the Decorations page starts empty and explains itself", text_present("No decorations yet") and text_present("Import decorations"))
    inp = d.find_element(By.CSS_SELECTOR, "input[aria-label='Import decorations']"); inp.send_keys(pk_none)
    for _ in range(40):
        time.sleep(0.5)
        if d.execute_script("return !!document.querySelector('[data-testid=decor-problem]')"): break
    check("a package with no model is refused on this page too, with the reason", "no 3D model" in d.execute_script("return (document.querySelector('[data-testid=decor-problem]')||{}).textContent||''"))
    d.find_element(By.CSS_SELECTOR, "input[aria-label='Import decorations']").send_keys(pk_pack)
    wait(40).until(lambda x: x.execute_script("return !!document.querySelector('[data-testid=decor-picker]')"))
    check("a pack lists its models to tick (the unusable .blend isn't offered)", d.execute_script("return [...document.querySelectorAll('[data-testid=decor-picker] [data-pick]')].map(l=>l.dataset.pick).sort().join('|')") == "Lamp.glb|Plant.glb|Table.glb")
    check("Add is off until something is ticked", d.execute_script("return document.querySelector('[data-act=add]').disabled") is True)
    d.execute_script("document.querySelector('[data-act=all]').click()"); time.sleep(0.3)
    d.execute_script("document.querySelector('[data-act=add]').click()")
    wait(60).until(lambda x: x.execute_script("return document.querySelectorAll('[data-decor]').length") == 3)
    items = {i["name"]: i for i in invoke("list_decor")}
    check("each ticked model became a decoration, not shareable by default", set(items) == {"Lamp", "Plant", "Table"} and all(not i["share"] and os.path.exists(i["path"]) and i["bytes"] == len(gb) for i in items.values()), str(items)[:300])
    check("the package's temporary files are gone", not [f for f in os.listdir(media_dir) if f.startswith((".roomup-", "pkgtmp-"))])
    d.execute_script("document.querySelector('[data-decor=\"Lamp\"] [data-share=\"yes\"]').click()"); time.sleep(0.8)
    check("the sharing mark can be switched on", {i["name"]: i["share"] for i in invoke("list_decor")}["Lamp"] is True)
    d.execute_script("[...document.querySelectorAll('[data-decor=\"Plant\"] button')].find(b=>b.textContent.includes('Rename')).click()"); time.sleep(0.4)
    ei = d.find_element(By.CSS_SELECTOR, "input[aria-label='Decoration name']"); ei.send_keys(Keys.CONTROL + "a"); ei.send_keys("Fern" + Keys.ENTER); time.sleep(0.8)
    d.execute_script("window.confirm=()=>true; [...document.querySelectorAll('[data-decor=\"Table\"] button')].find(b=>b.textContent.includes('Delete')).click()"); time.sleep(0.9)
    items = {i["name"]: i for i in invoke("list_decor")}
    check("a decoration can be renamed and deleted (its file goes too)", set(items) == {"Lamp", "Fern"} and not any(f.endswith(".glb") and "decor-" in f and os.path.join(media_dir, f) not in [i["path"] for i in items.values()] for f in os.listdir(media_dir)), str(list(items)))
    check("only a real .glb is accepted into the library", "valid 3D model" in (inv_err("decor_finish", {"token": upload(pk_text), "name": "Bad"}) or ""))
    # export: only the shareable one goes along; eject removes the other with a warning
    rt = invoke("save_character", {"character": {"card": dict(card0, name="Gallery Trip", first_mes="Hello!")}})
    rt_items = [invoke_file("add_gallery_image", p_, {"x-char-id": rt["id"], "x-file-name": os.path.basename(p_)})["gallery"][-1]["id"] for p_ in (gpics["happy"], gpics["sad"])]
    invoke("set_gallery_moods", {"id": rt["id"], "itemId": rt_items[0], "moods": ["happy", "smug"]}); invoke("set_gallery_mode", {"id": rt["id"], "mode": "mood"})
    invoke("save_prompt", {"prompt": {"id": "", "title": "Round trip", "body": "[OOC: it came back.]", "tag": "Style", "created_at": 0, "updated_at": 0}})
    rtpb = invoke("save_playbook", {"playbook": dict(pbd, name="Round trip story")})
    invoke("save_character", {"character": dict(rt, playbook=rtpb["id"])})
    rtchat = invoke("create_chat", {"dormId": None, "name": "pb round trip", "kind": "dm", "characterIds": [rt["id"]]})
    invoke("set_chat_playbook", {"chatId": rtchat["id"], "mode": "set", "playbookId": rtpb["id"], "scenario": "Friends"})
    rt_cm_ = invoke("add_gallery_comment", {"picKey": f"char:{rt['id']}:{rt_items[0]}", "parentId": None, "author": "Me", "body": "A comment that travels."})
    invoke("add_gallery_comment", {"picKey": f"char:{rt['id']}:{rt_items[0]}", "parentId": rt_cm_["id"], "author": "Me", "body": "And its answer."})
    invoke("save_custom_deco", {"items": [{"did": "cw_0a1b2c3d4e", "dkind": "wreath", "mode": "svg", "name": "Backup ring", "art": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><circle cx="72" cy="72" r="66" fill="none" stroke="gold" stroke-width="6"/></svg>'}]})
    info = invoke("prepare_export")
    check("the export names the decoration that isn't shareable and leaves it out", info["withheld_items"] == ["Fern"], str(info))
    xp = os.path.join(WORK, "decor.dorms"); invoke("save_export", {"token": info["token"], "path": xp})
    n_glb = len([f for f in os.listdir(media_dir) if f.startswith("decor-")])
    invoke("eject_profile", {"token": info["token"]})
    check("eject removes both decoration files from the device", len([f for f in os.listdir(media_dir) if f.startswith("decor-")]) == n_glb - 2)
    invoke_file("import_profile", xp, {"x-mode": "import", "x-handle": "Roomer3", "x-passcode": ""})
    back = invoke("list_decor")
    back_rt_ = next((c_ for c_ in invoke("list_characters") if c_["card"]["name"] == rt["card"]["name"]), None)   # (the profile was ejected first, so it may even have the same id)
    back_cm_ = invoke("gallery_comments", {"picKey": f"char:{back_rt_['id']}:{rt_items[0]}"}) if back_rt_ else []
    check("comments under a character's pictures come back with a backup, answers still under their comments", len(back_cm_) == 2 and [c_["body"] for c_ in back_cm_] == ["A comment that travels.", "And its answer."] and back_cm_[1]["parent_id"] == back_cm_[0]["id"], str((back_rt_ and back_rt_["id"], rt["id"], back_cm_))[:400])
    check("a person's own decorations come back with a backup", any(x["did"] == "cw_0a1b2c3d4e" and x["name"] == "Backup ring" for x in invoke("list_custom_deco")), str(invoke("list_custom_deco"))[:200])
    gt = [c_ for c_ in invoke("list_characters") if c_["card"]["name"] == "Gallery Trip"]
    check("a character's gallery comes back with a backup (pictures, moods and mode)", len(gt) == 1 and len(gt[0]["gallery"]) == 2 and gt[0]["gallery"][0]["moods"] == ["happy", "smug"] and gt[0]["gallery_mode"] == "mood" and all(os.path.exists(x["path"]) for x in gt[0]["gallery_paths"]), str(gt)[:300])
    rp = invoke("list_prompts")
    back_pb = [x for x in invoke("list_playbooks") if x["name"] == "Round trip story"]
    back_gt = [c_ for c_ in invoke("list_characters") if c_["card"]["name"] == "Gallery Trip"]
    back_chat = [c_ for c_ in invoke("list_chats") if c_["name"] == "pb round trip"]
    back_cp = invoke("get_chat_playbook", {"chatId": back_chat[0]["id"]}) if back_chat else None
    check("playbooks come back with a backup: the playbook, the character that comes with it, and where a chat's story stood", len(back_pb) == 1 and back_gt and back_gt[0].get("playbook") == back_pb[0]["id"] and back_cp and back_cp["mode"] == "set" and back_cp["active"]["id"] == back_pb[0]["id"] and back_cp["values"][0]["value"] == 8, str((back_pb, back_cp))[:400])
    check("saved prompts come back with a backup (title, label and text)", [(x["title"], x["tag"], x["body"]) for x in rp] == [("Round trip", "Style", "[OOC: it came back.]")], str(rp))
    check("the profile came back with only the shareable decoration, still marked shareable", [(i["name"], i["share"]) for i in back] == [("Lamp", True)] and os.path.exists(back[0]["path"]), str(back))

    # the Gallery: every character's pictures as art folders, with their own gallery as a sub folder
    art_ = invoke("save_character", {"character": {"card": dict(card0, name="Art Folder", first_mes="Hi")}})
    plain_ = invoke("save_character", {"character": {"card": dict(card0, name="Plain Art", first_mes="Hi")}})
    set_media_ipc(art_["id"], gpics["happy"]); set_media_ipc(plain_["id"], gpics["calm"])
    for k_ in ("sad", "calm"): invoke_file("add_gallery_image", gpics[k_], {"x-char-id": art_["id"], "x-file-name": "af-" + k_ + ".png"})
    reload_ui(); nav("Gallery"); time.sleep(1.0)
    check("the side bar has a Gallery, right after Characters", d.execute_script("const b=[...document.querySelectorAll('nav button')].map(x=>x.textContent.trim()); const i=b.findIndex(t=>t.includes('Characters')); return b[i+1] && b[i+1].includes('Gallery')"))
    folders_ = d.execute_script("return Object.fromEntries([...document.querySelectorAll('[data-gallery-folder]')].map(b => [b.dataset.galleryFolder, b.textContent]))")
    check("every character has an art folder that says how many pictures it holds", "3 pictures" in folders_.get("Art Folder", "") and "gallery of 2" in folders_.get("Art Folder", "") and "1 picture" in folders_.get("Plain Art", "") and "gallery of" not in folders_.get("Plain Art", ""), str(folders_)[:300])
    d.execute_script("document.querySelector('[data-testid=gallery-only]').click()"); time.sleep(0.4)
    check("'only characters with a gallery' hides the ones without", d.execute_script("const n=[...document.querySelectorAll('[data-gallery-folder]')].map(b=>b.dataset.galleryFolder); return n.includes('Art Folder') && !n.includes('Plain Art')"))
    d.execute_script("document.querySelector('[data-testid=gallery-only]').click()"); time.sleep(0.3)
    d.execute_script("document.querySelector('[data-gallery-folder=\"Art Folder\"]').click()"); time.sleep(0.6)
    check("opening a folder shows the profile picture and the gallery as a sub folder", d.execute_script("return !!document.querySelector('[data-testid=gallery-contents] [data-gallery-tile$=\":profile\"]') && !!document.querySelector('[data-gallery-sub=gallery]')"))
    d.execute_script("document.querySelector('[data-gallery-sub=gallery]').click()"); time.sleep(0.5)
    check("the gallery sub folder holds the character's gallery pictures", d.execute_script("return document.querySelectorAll('[data-testid=gallery-tiles] [data-gallery-tile]').length") == 2 and "Gallery" in d.find_element(By.CSS_SELECTOR, "[data-testid=gallery-crumbs]").text)
    d.execute_script("document.querySelector('[data-testid=gallery-tiles] [data-gallery-tile]').click()"); time.sleep(0.5)
    src1_ = d.execute_script("return document.querySelector('[data-testid=gallery-big] img').src")
    check("a picture opens big", len(d.find_elements(By.CSS_SELECTOR, "[data-testid=gallery-viewer]")) == 1 and bool(src1_))
    d.find_element(By.CSS_SELECTOR, "[data-testid=gallery-next]").click(); time.sleep(0.4)
    check("the arrows move to the next picture", d.execute_script("return document.querySelector('[data-testid=gallery-big] img').src") != src1_)
    d.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE); time.sleep(0.4)
    check("Escape closes the viewer", len(d.find_elements(By.CSS_SELECTOR, "[data-testid=gallery-viewer]")) == 0)
    d.execute_script("[...document.querySelectorAll('[data-testid=gallery-crumbs] button')].find(b=>b.textContent.includes('Gallery')).click()"); time.sleep(0.5)
    check("the crumbs lead back to all the folders", len(d.find_elements(By.CSS_SELECTOR, "[data-testid=gallery-folders]")) == 1)
    # comments under a picture: like a forum thread, kept on the device
    d.execute_script("document.querySelector('[data-gallery-folder=\"Art Folder\"]').click()"); time.sleep(0.5)
    d.execute_script("document.querySelector('[data-gallery-sub=gallery]').click()"); time.sleep(0.5)
    first_tile_ = d.execute_script("return document.querySelector('[data-testid=gallery-tiles] [data-gallery-tile]').dataset.galleryTile")
    pkey_ = "char:" + first_tile_
    d.execute_script("document.querySelector('[data-testid=gallery-tiles] [data-gallery-tile]').click()"); time.sleep(0.6)
    check("the viewer has a comment section that starts empty", len(d.find_elements(By.CSS_SELECTOR, "[data-testid=picture-comments]")) == 1 and len(d.find_elements(By.CSS_SELECTOR, "[data-testid=comments-empty]")) == 1)
    set_value("[data-testid=comment-text]", "Lovely light in this one."); d.find_element(By.CSS_SELECTOR, "[data-testid=comment-post]").click(); time.sleep(0.8)
    set_value("[data-testid=comment-text]", "Second thought:\nthe colours again."); d.find_element(By.CSS_SELECTOR, "[data-testid=comment-post]").click(); time.sleep(0.8)
    cm_ = invoke("gallery_comments", {"picKey": pkey_})
    check("comments are posted and kept, line breaks included, in order", [c_["body"] for c_ in cm_] == ["Lovely light in this one.", "Second thought:\nthe colours again."] and all(c_["parent_id"] is None and c_["author"] for c_ in cm_), str(cm_)[:300])
    d.execute_script("document.querySelector('[data-comment] [data-testid=comment-reply]').click()"); time.sleep(0.4)
    set_value("[data-testid=reply-text]", "Agreed, the light is the best part."); d.find_element(By.CSS_SELECTOR, "[data-testid=reply-post]").click(); time.sleep(0.8)
    cm_ = invoke("gallery_comments", {"picKey": pkey_}); rep_ = [c_ for c_ in cm_ if c_["parent_id"]]
    check("a comment can be answered, and the answer sits under it (indented)", len(rep_) == 1 and rep_[0]["parent_id"] == cm_[0]["id"] and d.execute_script("return document.querySelectorAll('[data-comment][data-depth=\"1\"]').length") == 1)
    d.execute_script("document.querySelector('[data-comment=\"%s\"] [data-testid=comment-reply]').click()" % rep_[0]["id"]); time.sleep(0.4)
    set_value("[data-testid=reply-text]", "And an answer to the answer."); d.find_element(By.CSS_SELECTOR, "[data-testid=reply-post]").click(); time.sleep(0.8)
    check("answers can be answered too", d.execute_script("return document.querySelectorAll('[data-comment][data-depth=\"2\"]').length") == 1)
    d.execute_script("document.querySelector('[data-comment=\"%s\"] [data-testid=comment-edit]').click()" % cm_[1]["id"]); time.sleep(0.3)
    set_value("[data-testid=comment-edit-text]", "Second thought, edited."); d.find_element(By.CSS_SELECTOR, "[data-testid=comment-edit-save]").click(); time.sleep(0.8)
    ed_ = next(c_ for c_ in invoke("gallery_comments", {"picKey": pkey_}) if c_["id"] == cm_[1]["id"])
    check("a comment can be edited, and says it was", ed_["body"] == "Second thought, edited." and ed_["edited_at"] and "edited" in d.execute_script("return document.querySelector('[data-comment=\"%s\"] .pc-head').textContent" % ed_["id"]))
    d.find_element(By.CSS_SELECTOR, "[data-testid=gallery-next]").click(); time.sleep(0.5)
    check("each picture has its own comments (the next one has none)", len(d.find_elements(By.CSS_SELECTOR, "[data-testid=comments-empty]")) == 1)
    set_value("[data-testid=comment-text]", "x"); d.find_element(By.CSS_SELECTOR, "[data-testid=comment-text]").send_keys(Keys.ARROW_LEFT); time.sleep(0.3)
    check("typing in the comment box doesn't flip the picture", len(d.find_elements(By.CSS_SELECTOR, "[data-testid=comments-empty]")) == 1)
    for i_ in range(60): invoke("add_gallery_comment", {"picKey": pkey_, "parentId": None, "author": "Me", "body": f"note {i_}"})
    check("there is no limit to how many comments a picture can have", len(invoke("gallery_comments", {"picKey": pkey_})) == 4 + 60)
    check("the comment is limited only in length", "too long" in (inv_err("add_gallery_comment", {"picKey": pkey_, "parentId": None, "author": "Me", "body": "x" * 20001}) or "") and "Write something" in (inv_err("add_gallery_comment", {"picKey": pkey_, "parentId": None, "author": "Me", "body": "   "}) or ""))
    check("a comment can't answer one under another picture or one that isn't there", all(inv_err("add_gallery_comment", {"picKey": "char:" + first_tile_.replace(first_tile_.split(":")[1], "zzz"), "parentId": cm_[0]["id"], "author": "Me", "body": "hi"}) is not None for _ in [0]) and inv_err("add_gallery_comment", {"picKey": pkey_, "parentId": "nope", "author": "Me", "body": "hi"}) is not None)
    d.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE); time.sleep(0.4)
    d.find_element(By.CSS_SELECTOR, "[data-testid=gallery-close]").click() if d.find_elements(By.CSS_SELECTOR, "[data-testid=gallery-close]") else None
    time.sleep(0.4)
    check("a picture with comments shows how many on its tile", d.execute_script("const t=document.querySelector('[data-testid=gallery-tiles] [data-gallery-tile]'); const b=t&&t.querySelector('[data-testid=comment-count]'); return !!b && /💬\\s*\\d+/.test(b.textContent)"))
    n_before_ = len(invoke("gallery_comments", {"picKey": pkey_}))
    d.execute_script("window.confirm=()=>true"); d.execute_script("document.querySelector('[data-testid=gallery-tiles] [data-gallery-tile]').click()"); time.sleep(0.6)
    d.execute_script("document.querySelector('[data-comment=\"%s\"] [data-testid=comment-delete]').click()" % cm_[0]["id"]); time.sleep(0.9)
    check("deleting a comment takes the answers under it with it", len(invoke("gallery_comments", {"picKey": pkey_})) == n_before_ - 3)
    d.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE); time.sleep(0.3)
    nav("Characters"); nav("Gallery"); time.sleep(0.6)
    # adding to a character's gallery from a picture link (right in the Gallery)
    n_gal_ = len(invoke("get_character", {"id": art_["id"]}).get("gallery", []))
    d.execute_script("document.querySelector('[data-gallery-folder=\"Art Folder\"]').click()"); time.sleep(0.6)
    set_value("[data-testid=gallery-folder-link-input]", "http://127.0.0.1:18997/cat.png"); time.sleep(0.3)
    d.find_element(By.CSS_SELECTOR, "[data-testid=gallery-folder-link-use]").click(); time.sleep(2.5)
    check("a picture link adds a picture to the character's own gallery", len(invoke("get_character", {"id": art_["id"]}).get("gallery", [])) == n_gal_ + 1)
    check("and the new picture shows in the sub folder at once", "%d pictures" % (n_gal_ + 1) in d.execute_script("const b=document.querySelector('[data-gallery-sub=gallery]'); return b ? b.textContent : ''"))
    set_value("[data-testid=gallery-folder-link-input]", "http://127.0.0.1:18997/page"); d.find_element(By.CSS_SELECTOR, "[data-testid=gallery-folder-link-use]").click(); time.sleep(1.5)
    check("a link to a web page adds nothing", len(invoke("get_character", {"id": art_["id"]}).get("gallery", [])) == n_gal_ + 1)
    d.execute_script("[...document.querySelectorAll('[data-testid=gallery-crumbs] button')].find(b=>b.textContent.includes('Gallery')).click()"); time.sleep(0.5)
    # folders from the computer: only to look at, nothing to do with any character
    vroot_ = os.path.join(WORK, "view-art")
    for sub_ in ("sub", ".hidden", "empty"): os.makedirs(os.path.join(vroot_, sub_), exist_ok=True)
    for rel_, rgb_ in (("a.png", (200, 60, 60)), ("b.png", (60, 200, 60)), ("sub/c.png", (60, 60, 200)), (".hidden/x.png", (1, 2, 3))): _Img.new("RGB", (40, 60), rgb_).save(os.path.join(vroot_, rel_))
    open(os.path.join(vroot_, "notes.txt"), "w").write("not a picture")
    vf_ = invoke("add_view_folder", {"path": vroot_})
    check("a folder from the computer can be added to the Gallery", vf_["name"] == "view-art" and vf_["exists"] is True, str(vf_))
    check("the same folder is not added twice", "already" in (inv_err("add_view_folder", {"path": vroot_}) or ""))
    check("the app's own data folder, a drive root, a system folder and a hidden folder are refused", all(inv_err("add_view_folder", {"path": q_}) for q_ in [DATA, os.path.dirname(DATA), "/", "/etc", os.path.join(vroot_, ".hidden"), os.path.join(vroot_, "notes.txt"), "relative/dir", ""]))
    sc_ = invoke("scan_view_folder", {"id": vf_["id"]})
    check("a folder is read into its pictures and the folders inside it (no text files, hidden folders or empty folders)", sc_["root"]["total"] == 3 and [f_["name"] for f_ in sc_["root"]["files"]] == ["a.png", "b.png"] and [x_["name"] for x_ in sc_["root"]["dirs"]] == ["sub"] and not sc_["truncated"], str(sc_)[:300])
    reload_ui(); nav("Gallery"); time.sleep(1.5)
    card_ = d.execute_script("const b=document.querySelector('[data-gallery-disk-folder=\"view-art\"]'); return b ? b.textContent : null")
    check("the Gallery lists it under From my computer, with how many pictures it holds", card_ and "3 pictures" in card_ and "1 folder" in card_, str(card_))
    d.execute_script("document.querySelector('[data-gallery-disk-folder=\"view-art\"]').click()"); time.sleep(2.5)
    check("opening it shows its pictures and the folders inside as folders", d.execute_script("return document.querySelectorAll('[data-testid=gallery-tiles] [data-gallery-tile]').length") == 2 and d.execute_script("return !!document.querySelector('[data-gallery-subdir=sub]')"))
    check("the pictures are really drawn (the page may read the folder)", d.execute_script("return [...document.querySelectorAll('[data-testid=gallery-tiles] img')].every(i => i.complete && i.naturalWidth > 0)"))
    d.execute_script("document.querySelector('[data-gallery-subdir=sub]').click()"); time.sleep(0.6)
    check("a folder inside opens as a sub folder, with crumbs back", d.execute_script("return document.querySelectorAll('[data-testid=gallery-tiles] [data-gallery-tile]').length") == 1 and "view-art" in d.find_element(By.CSS_SELECTOR, "[data-testid=gallery-crumbs]").text)
    d.execute_script("document.querySelector('[data-testid=gallery-tiles] [data-gallery-tile]').click()"); time.sleep(0.5)
    check("a picture from the computer opens big, and has no Open character button", len(d.find_elements(By.CSS_SELECTOR, "[data-testid=gallery-viewer]")) == 1 and "Open character" not in d.find_element(By.CSS_SELECTOR, "[data-testid=gallery-viewer]").text)
    # the viewer: zoom, and how the picture is sized
    zl_ = lambda: d.find_element(By.CSS_SELECTOR, "[data-testid=zoom-level]").text
    check("the viewer starts at 100% in Fit mode", zl_() == "100%" and d.find_element(By.CSS_SELECTOR, "[data-testid=stage-image]").get_attribute("data-fit") == "fit")
    d.find_element(By.CSS_SELECTOR, "[data-testid=zoom-in]").click(); d.find_element(By.CSS_SELECTOR, "[data-testid=zoom-in]").click(); time.sleep(0.2)
    check("zoom in makes the picture bigger", zl_() == "156%", zl_())
    d.find_element(By.CSS_SELECTOR, "[data-testid=zoom-out]").click(); time.sleep(0.2)
    check("zoom out makes it smaller", zl_() == "125%", zl_())
    d.find_element(By.CSS_SELECTOR, "[data-testid=zoom-reset]").click(); time.sleep(0.2)
    check("the zoom resets to 100%", zl_() == "100%")
    for fit_ in ("actual", "fill", "stretch", "fit"):
        d.find_element(By.CSS_SELECTOR, "[data-fit=%s]" % fit_).click(); time.sleep(0.2)
        check("the size mode %s applies" % fit_, d.find_element(By.CSS_SELECTOR, "[data-testid=stage-image]").get_attribute("data-fit") == fit_)
    d.find_element(By.CSS_SELECTOR, "[data-fit=fill]").click(); time.sleep(0.2)
    check("the chosen size mode is remembered", d.execute_script("return localStorage.getItem('dorms.gallery.fit')") == "fill")
    d.find_element(By.CSS_SELECTOR, "[data-fit=fit]").click(); time.sleep(0.2)
    d.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE); time.sleep(0.4)
    d.execute_script("[...document.querySelectorAll('[data-testid=gallery-crumbs] button')].find(b=>b.textContent.includes('Gallery')).click()"); time.sleep(0.6)
    d.execute_script("window.confirm=()=>true; document.querySelector('[data-testid=gallery-remove-folder]').click()"); time.sleep(1.0)
    vroot2_ = os.path.join(WORK, "view-art-2")
    os.makedirs(vroot2_, exist_ok=True)
    for rel_, rgb_ in (("p.png", (10, 120, 200)), ("q.png", (200, 120, 10))): _Img.new("RGB", (3000, 2000), rgb_).save(os.path.join(vroot2_, rel_))
    vf2_ = invoke("add_view_folder", {"path": vroot2_})
    reload_ui(); nav("Gallery"); time.sleep(1.5)
    d.execute_script("document.querySelector('[data-gallery-disk-folder=\"view-art-2\"]').click()"); time.sleep(2.5)
    check("a second folder from the computer opens without the Gallery failing", len(d.find_elements(By.CSS_SELECTOR, "[data-testid=gallery-error]")) == 0 and d.execute_script("return document.querySelectorAll('[data-testid=gallery-tiles] [data-gallery-tile]').length") == 2)
    check("big pictures are shown as small copies in the tiles", d.execute_script("return [...document.querySelectorAll('[data-testid=gallery-tiles] img')].every(i => i.complete && i.naturalWidth > 0 && i.naturalWidth <= 360)") and os.path.isdir(os.path.join(DATA, "media", "gallery-thumbs")))
    d.execute_script("[...document.querySelectorAll('[data-testid=gallery-crumbs] button')].find(b=>b.textContent.includes('Gallery')).click()"); time.sleep(0.6)
    invoke("remove_view_folder", {"id": vf2_["id"]})
    check("taking a folder off the Gallery forgets it", invoke("list_view_folders") == [] and d.execute_script("return !document.querySelector('[data-gallery-disk-folder]')"))
    check("and nothing on the computer is touched", all(os.path.exists(os.path.join(vroot_, r_)) for r_ in ("a.png", "b.png", "sub/c.png", "notes.txt")))
    # gallery folders made in the app, the Add folder menu, arranging folders and keeping everything in one place
    own_ = invoke("create_gallery_folder", {"name": "  Fan art  "})
    check("a gallery folder can be made in the app (named, trimmed, marked as the app's)", own_["name"] == "Fan art" and own_["own"] is True and own_["exists"] is True and os.path.isdir(own_["path"]) and os.path.join(DATA, "gallery-folders") in own_["path"], str(own_))
    check("two folders can't share a name, and a folder needs a name", "already" in (inv_err("create_gallery_folder", {"name": "fan ART"}) or "") and "name" in (inv_err("create_gallery_folder", {"name": "   "}) or ""))
    pp_ = invoke_file("add_folder_picture", os.path.join(FIX, "avatar.gif"), {"x-folder-id": own_["id"], "x-file-name": "cute%20gif.png"})
    check("a picture can be added to it (what it is comes from its bytes, so it gets the right ending)", pp_.endswith("cute gif.gif") and os.path.isfile(pp_), pp_)
    pp2_ = invoke_file("add_folder_picture", os.path.join(FIX, "avatar.gif"), {"x-folder-id": own_["id"], "x-file-name": "cute%20gif.gif"})
    check("a second file with the same name doesn't overwrite the first", pp2_ != pp_ and os.path.isfile(pp_) and os.path.isfile(pp2_))
    check("a text file is not added", "isn't a picture" in (inv_err_file("add_folder_picture", os.path.join(vroot_, "notes.txt"), {"x-folder-id": own_["id"], "x-file-name": "notes.png"}) or ""))
    dsk_ = invoke("add_view_folder", {"path": vroot_})
    check("a folder from the computer (or one that doesn't exist) can't be added to", bool(inv_err_file("add_folder_picture", os.path.join(FIX, "avatar.gif"), {"x-folder-id": dsk_["id"], "x-file-name": "a.gif"})) and bool(inv_err_file("add_folder_picture", os.path.join(FIX, "avatar.gif"), {"x-folder-id": "nope", "x-file-name": "a.gif"})))
    invoke("remove_view_folder", {"id": dsk_["id"]})
    sc2_ = invoke("scan_view_folder", {"id": own_["id"]})
    check("the folder lists the pictures in it", sc2_["root"]["total"] == 2, str(sc2_)[:200])
    thumb_ = invoke("view_thumb", {"path": pp_})
    check("it gets small copies like any other folder", os.path.isfile(thumb_))
    reload_ui(); nav("Gallery"); time.sleep(1.5)
    d.execute_script("document.querySelector('[data-testid=gallery-add-folder]').click()"); time.sleep(0.4)
    check("Add folder opens a menu: pick from desktop, copy from a link, new gallery folder", d.execute_script("const m=document.querySelector('[data-testid=gallery-add-menu]');return !!m && !!m.querySelector('[data-testid=gallery-add-desktop]') && !!m.querySelector('[data-testid=gallery-add-link]') && !!m.querySelector('[data-testid=gallery-add-new]') && document.querySelector('[data-testid=gallery-add-folder]').textContent.includes('Add folder')"))
    d.execute_script("document.querySelector('[data-testid=gallery-add-new]').click()"); time.sleep(0.4)
    set_value("[data-testid=gallery-new-folder-name]", "Wallpapers"); d.execute_script("document.querySelector('[data-testid=gallery-new-folder-make]').click()"); time.sleep(1.0)
    check("a new gallery folder can be made from the menu and shows up at once", d.execute_script("return !!document.querySelector('[data-gallery-disk-folder=\"Wallpapers\"][data-gallery-own]') && !!document.querySelector('[data-gallery-disk-folder=\"Fan art\"][data-gallery-own]')"))
    d.execute_script("document.querySelector('[data-testid=gallery-add-folder]').click()"); time.sleep(0.3)
    d.execute_script("document.querySelector('[data-testid=gallery-add-link]').click()"); time.sleep(0.5)
    check("Copy from a link asks which folder, with a new folder as a choice", d.execute_script("const s=document.querySelector('[data-testid=gallery-link-folder]');return !!s && [...s.options].some(o=>o.textContent==='Fan art') && [...s.options].some(o=>o.textContent.includes('A new folder'))"))
    d.execute_script("const s=document.querySelector('[data-testid=gallery-link-folder]');s.value=[...s.options].find(o=>o.textContent==='Wallpapers').value;s.dispatchEvent(new Event('change',{bubbles:true}))"); time.sleep(0.3)
    wp_ = [f_ for f_ in invoke("list_view_folders") if f_["name"] == "Wallpapers"][0]
    set_value("[data-testid=gallery-link-box-input]", "http://127.0.0.1:18997/cat.png"); d.execute_script("document.querySelector('[data-testid=gallery-link-box-use]').click()"); time.sleep(2.5)
    check("a picture from a link is copied into the chosen folder", invoke("scan_view_folder", {"id": wp_["id"]})["root"]["total"] == 1 and "cat" in invoke("scan_view_folder", {"id": wp_["id"]})["root"]["files"][0]["name"])
    d.execute_script("document.querySelector('[data-testid=gallery-link-dialog] .btn:last-child').click()"); time.sleep(0.4)
    invoke("create_gallery_folder", {"name": "Sketches"}); reload_ui(); nav("Gallery"); time.sleep(1.5)
    # arranging: the arrows in Arrange mode move a folder, and the order is kept
    d.execute_script("document.querySelector('[data-testid=gallery-arrange]').click()"); time.sleep(0.3)
    disk_keys_ = lambda: d.execute_script("return [...document.querySelectorAll('[data-testid=gallery-disk-folders] [data-gal-key]')].map(x=>x.dataset.galKey)")
    k0_ = disk_keys_()
    check("the folders have a place in a row to move within", len(k0_) >= 3, str(k0_))
    d.execute_script("document.querySelectorAll('[data-testid=gallery-disk-folders] [data-testid=gallery-move-earlier]')[arguments[0]].click()", len(k0_) - 1); time.sleep(1.0)
    k1_ = disk_keys_()
    check("the arrow moves a folder one place earlier", k1_ == k0_[:-2] + [k0_[-1], k0_[-2]], f"{k0_} -> {k1_}")
    check("and the order is saved", invoke("get_settings")["gallery_order"][:len(k1_)] == k1_)
    reload_ui(); nav("Gallery"); time.sleep(1.5)
    check("the order is still there after a restart of the screen", disk_keys_() == k1_)
    d.execute_script("""const a=document.querySelectorAll('[data-testid=gallery-disk-folders] [data-gal-key]');const dt=new DataTransfer();
      const fire=(el,t)=>el.dispatchEvent(new DragEvent(t,{bubbles:true,cancelable:true,dataTransfer:dt}));
      fire(a[a.length-1],'dragstart');fire(a[0],'dragover');fire(a[0],'drop');fire(a[a.length-1],'dragend');""")
    time.sleep(1.0)
    k2_ = disk_keys_()
    check("dragging a folder onto another puts it there", k2_[0] == k1_[-1] and sorted(k2_) == sorted(k1_), f"{k1_} -> {k2_}")
    # all in one place
    check("by default characters' folders and the others are in separate sections", d.execute_script("return !!document.querySelector('[data-testid=gallery-disk]') && !document.querySelector('[data-testid=gallery-folders] [data-gallery-disk-folder]')"))
    d.execute_script("document.querySelector('[data-testid=gallery-merge]').click()"); time.sleep(1.0)
    check("the switch puts every folder in one place", d.execute_script("const g=document.querySelector('[data-testid=gallery-folders]');return !!g && !!g.querySelector('[data-gallery-folder]') && !!g.querySelector('[data-gallery-disk-folder]') && !document.querySelector('[data-testid=gallery-disk]')") and invoke("get_settings")["gallery_merge"] is True)
    reload_ui(); nav("Gallery"); time.sleep(1.5)
    check("and it is remembered", d.execute_script("return document.querySelector('[data-testid=gallery-merge]').checked && !!document.querySelector('[data-testid=gallery-folders] [data-gallery-disk-folder]')"))
    d.execute_script("document.querySelector('[data-testid=gallery-merge]').click()"); time.sleep(0.8)
    d.execute_script("document.querySelector('[data-gallery-disk-folder=\"Fan art\"]').click()"); time.sleep(1.2)
    check("opening one of your own folders has a place to add pictures and a delete button on each", d.execute_script("return !!document.querySelector('[data-testid=gallery-own-add]') && document.querySelectorAll('[data-testid=gallery-delete-pic]').length === 2"))
    d.execute_script("window.confirm=()=>true; document.querySelector('[data-testid=gallery-delete-pic]').click()"); time.sleep(1.2)
    check("deleting a picture removes the file", invoke("scan_view_folder", {"id": own_["id"]})["root"]["total"] == 1 and (not os.path.exists(pp_) or not os.path.exists(pp2_)))
    d.execute_script("[...document.querySelectorAll('[data-testid=gallery-crumbs] button')].find(b=>b.textContent.includes('Gallery')).click()"); time.sleep(0.6)
    d.execute_script("window.confirm=()=>true; [...document.querySelectorAll('[data-gallery-own]')].find(b=>b.dataset.galleryDiskFolder==='Fan art').closest('.gal-folder-wrap').querySelector('[data-testid=gallery-remove-folder]').click()"); time.sleep(1.0)
    check("deleting an app folder removes it and its pictures from the disk", not os.path.exists(own_["path"]) and all(f_["id"] != own_["id"] for f_ in invoke("list_view_folders")))
    for f_ in invoke("list_view_folders"): invoke("remove_view_folder", {"id": f_["id"]})
    st_ = invoke("get_settings"); st_["gallery_order"] = []; st_["gallery_merge"] = False; invoke("save_settings", {"settings": st_})
    nav("Characters"); time.sleep(0.4)
    # a picture from a web address instead of an upload (the server for it is started before the media section)
    got_ = invoke("fetch_picture", {"url": "http://127.0.0.1:18997/cat.png?w=1"})
    check("a picture link is fetched and named from its address (the first bytes decide what it is, not the server's label)", got_["name"] == "cat.png" and got_["mime"] == "image/png" and _b64.b64decode(got_["data"]) == PNG_, str(got_)[:200])
    check("a link that redirects is followed", invoke("fetch_picture", {"url": "http://127.0.0.1:18997/redir"})["name"].endswith(".png"))
    check("a web page is refused with what to do instead", "web page" in (inv_err("fetch_picture", {"url": "http://127.0.0.1:18997/page"}) or "") and "Copy image" in (inv_err("fetch_picture", {"url": "http://127.0.0.1:18997/page"}) or ""))
    check("a missing picture says so", "404" in (inv_err("fetch_picture", {"url": "http://127.0.0.1:18997/nope.png"}) or ""))
    check("only web addresses are used", all(inv_err("fetch_picture", {"url": u}) for u in ["file:///etc/passwd", "ftp://example.com/a.png", "not a link", ""]))
    # drag a character into a chat
    hiro_c = by_name("Hiro Tanaka") or next(c_ for c_ in chars() if c_["id"] != mira["id"])
    dchat = invoke("create_chat", {"dormId": None, "name": "drag room", "kind": "dm", "characterIds": []})
    reload_ui(); nav("Dorms")
    d.find_element(By.XPATH, "//button[contains(@class,'it') and contains(., 'drag room')]").click(); time.sleep(0.8)
    check("an empty chat says how to add someone and has an Add a character button", "Drag one in" in d.find_element(By.CSS_SELECTOR, "[data-testid=side-panel-empty]").text and len(d.find_elements(By.CSS_SELECTOR, "[data-testid=add-person]")) == 1)
    def drop_person(pid):
        d.execute_script("""const el=document.querySelector('[data-testid=side-panel]');const dt=new DataTransfer();dt.setData('application/x-dorms-chat-character',JSON.stringify([arguments[0]]));
          for(const t of ['dragover','drop']) el.dispatchEvent(new DragEvent(t,{bubbles:true,cancelable:true,dataTransfer:dt}));""", pid)
        time.sleep(0.8)
    drop_person(mira["id"])
    got = next(c_ for c_ in invoke("list_chats") if c_["id"] == dchat["id"])
    check("dropping a character on an empty chat adds them", got["character_ids"] == [mira["id"]], str(got)[:200])
    drop_person(mira["id"])
    got = next(c_ for c_ in invoke("list_chats") if c_["id"] == dchat["id"])
    check("the same character is not added twice", got["character_ids"] == [mira["id"]])
    drop_person(hiro_c["id"])
    check("a second character on a one-to-one chat asks first", len(d.find_elements(By.CSS_SELECTOR, "[data-testid=group-ask]")) == 1)
    got = next(c_ for c_ in invoke("list_chats") if c_["id"] == dchat["id"])
    check("nothing changes until it is answered", got["kind"] == "dm" and got["character_ids"] == [mira["id"]])
    d.find_element(By.CSS_SELECTOR, "[data-testid=group-ask-yes]").click(); time.sleep(0.8)
    got = next(c_ for c_ in invoke("list_chats") if c_["id"] == dchat["id"])
    check("saying yes makes it a group chat with both in it", got["kind"] == "group" and got["character_ids"] == [mira["id"], hiro_c["id"]], str(got)[:200])
    # worlds that bring a persona, a playbook and standing instructions
    kai = invoke("save_persona", {"persona": {"id": "", "name": "Harbour Kai", "description": "A deckhand.", "style": "", "avatar": None, "frame": None, "created_at": 0}})
    pbs = invoke("save_playbook", {"playbook": dict(pbd, name="Harbour story")})
    ws = invoke("create_world", {"name": "Harbour", "description": "A salty port town."})
    wroom = invoke("create_room", {"room": dict(room_in, name="Pier", description="", owner_kind="self", character_id=None, id=0, created_at=0, world_id=ws["id"])})
    wdorm = invoke("create_dorm", {"name": "Harbour dorm", "roomId": wroom["id"]})
    wchat = invoke("create_chat", {"dormId": wdorm["id"], "name": "pier chat", "kind": "dm", "characterIds": [mira["id"]]})
    plain = invoke("create_chat", {"dormId": None, "name": "elsewhere", "kind": "dm", "characterIds": [mira["id"]]})
    shelf_p = invoke("save_prompt", {"prompt": {"id": "", "title": "Salty reply", "tag": "", "body": "[OOC: more salt]", "created_at": 0, "updated_at": 0}})
    set_ = invoke("set_world_setup", {"id": ws["id"], "persona": kai["id"], "playbook": pbs["id"], "instructions": "  Keep it salty.  ", "prompts": []})
    check("a world keeps its persona, playbook and instructions", (set_["persona"], set_["playbook"], set_["instructions"]) == (kai["id"], pbs["id"], "Keep it salty."), str(set_))
    bad = invoke("set_world_setup", {"id": ws["id"], "persona": "nope", "playbook": "nope", "instructions": "", "prompts": []})
    check("a persona or playbook that isn't yours is ignored", bad["persona"] == "" and bad["playbook"] == "")
    invoke("set_world_setup", {"id": ws["id"], "persona": kai["id"], "playbook": pbs["id"], "instructions": "Keep it salty.", "prompts": [shelf_p["id"], "not-mine"]})
    wp = invoke("get_chat_playbook", {"chatId": wchat["id"]})
    check("a chat in the world uses the world's playbook when nothing else chooses one", wp["active"] and wp["active"]["id"] == pbs["id"] and wp["from_world"], str(wp)[:200])
    check("a chat outside the world is unaffected", invoke("get_chat_playbook", {"chatId": plain["id"]})["active"] is None)
    reload_ui(); nav("Dorms")
    d.find_element(By.XPATH, "//button[contains(@class,'it') and contains(., 'pier chat')]").click(); time.sleep(1.0)
    line = d.find_elements(By.CSS_SELECTOR, "[data-testid=world-brings]")
    check("the chat says what its world brings", len(line) == 1 and "Harbour" in line[0].text and "playbook Harbour story" in line[0].text and "standing instructions" in line[0].text, line[0].text if line else "no line")
    check("a world's prompt shelf keeps only your own prompts", next(w_ for w_ in invoke("list_worlds") if w_["id"] == ws["id"])["prompts"] == [shelf_p["id"]])
    d.execute_script("document.querySelector('[data-testid=prompts-toggle]').click()"); time.sleep(1.0)
    check("the Prompts menu shows the world's shelf first while you are in a chat in it", "From Harbour" in d.find_element(By.CSS_SELECTOR, "[data-testid=prompts-world-shelf]").text and d.find_elements(By.CSS_SELECTOR, ".prompt-row")[0].get_attribute("data-prompt") == "Salty reply")
    d.execute_script("document.querySelector('[data-testid=prompts-toggle]').click()"); time.sleep(0.3)
    check("the world's persona is shown with a way to use your own here", len(d.find_elements(By.CSS_SELECTOR, "[data-testid=world-persona-off]")) == 1)
    d.find_element(By.CSS_SELECTOR, "[data-testid=world-persona-off]").click(); time.sleep(0.8)
    off_chat = next(c_ for c_ in invoke("list_chats") if c_["id"] == wchat["id"])
    check("choosing your own is remembered for that chat only", off_chat["world_persona_off"] is True and not next(c_ for c_ in invoke("list_chats") if c_["id"] == plain["id"])["world_persona_off"])
    check("and the chat offers to go back", len(d.find_elements(By.CSS_SELECTOR, "[data-testid=world-persona-on]")) == 1)

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
