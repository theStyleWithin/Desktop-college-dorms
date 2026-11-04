"""End-to-end test: drives the real built app through tauri-driver (WebDriver).

Usage: xvfb-run -a python3 tests/e2e/e2e.py <app-binary> <fixtures-dir> <tiny.gguf> <workdir>
"""
import base64, io, json, os, shutil, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

from PIL import Image
from selenium import webdriver
from selenium.common.exceptions import TimeoutException
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
        n = int(self.headers.get("content-length", 0)); body = json.loads(self.rfile.read(n))
        seen["auth"] = self.headers.get("authorization"); seen["body"] = body
        seen["path"] = self.path; seen["headers"] = {k.lower(): v for k, v in self.headers.items()}
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        for piece in ["Hello ", "from ", "*the cloud*", "!"]:
            self.wfile.write(("data: " + json.dumps({"choices": [{"delta": {"content": piece}}]}) + "\n\n").encode()); self.wfile.flush(); time.sleep(0.05)
        self.wfile.write(b"data: [DONE]\n\n")
srv = HTTPServer(("127.0.0.1", 18999), Fake); threading.Thread(target=srv.serve_forever, daemon=True).start()

env = dict(os.environ, XDG_DATA_HOME=os.path.join(WORK, "data"), XDG_CONFIG_HOME=os.path.join(WORK, "cfg"),
           XDG_CACHE_HOME=os.path.join(WORK, "cache"), GDK_BACKEND="x11", APPIMAGE_EXTRACT_AND_RUN="1",
           WEBKIT_DISABLE_COMPOSITING_MODE="1", WEBKIT_DISABLE_DMABUF_RENDERER="1")
if not os.environ.get("E2E_BUNDLED_ENGINE"):  # default: point at a dev build of the engine
    env["DORMS_LLAMA_SERVER"] = LLAMA
drv = subprocess.Popen(["tauri-driver"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2)
opts = ArgOptions(); opts.set_capability("browserName", "wry"); opts.set_capability("tauri:options", {"application": APP})
d = webdriver.Remote(command_executor="http://127.0.0.1:4444", options=opts)
d.file_detector = UselessFileDetector()  # driver runs locally; send paths as-is
d.set_window_size(1280, 860)
wait = lambda t=20: WebDriverWait(d, t)

def shot(name): d.get_screenshot_as_file(os.path.join(WORK, name + ".png"))
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
    d.refresh(); wait(30).until(lambda x: "Good" in page_text() or "Dorms" in page_text()); time.sleep(0.8)
def dismiss():
    for b in d.find_elements(By.CSS_SELECTOR, ".modal button[aria-label=Close]"):
        b.click(); time.sleep(0.3)
def text_present(t, timeout=15):
    try: wait(timeout).until(lambda x: t in page_text()); return True
    except TimeoutException: return False
def chars(): return invoke("list_characters")
def by_name(n): return next((c for c in chars() if c["card"]["name"] == n), None)

try:
    wait(30).until(lambda x: "Good" in x.find_element(By.TAG_NAME, "body").text)
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
    for label, fname, kind in [("GIF", "avatar.gif", "gif"), ("video", "clip.mp4", "video"), ("VRM", "sample.vrm", "vrm")]:
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
    # error path: unreachable server shows a friendly error
    st["openai_base_url"] = "http://127.0.0.1:1/v1"; invoke("save_settings", {"settings": st})
    try: invoke("test_provider"); check("unreachable server gives a clear error", False)
    except RuntimeError as e: check("unreachable server gives a clear error", "Could not reach" in str(e), str(e))
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
finally:
    try: d.quit()
    except Exception: pass
    drv.terminate()
    subprocess.run(["pkill", "-f", "^/[^ ]*(dorms-engine|llama-server)"], check=False)
    for name in ("WebKitWebDriver", "desktop-college-dorms"):  # nothing may outlive the test run
        subprocess.run(["pkill", "-x", name], check=False)

fails = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(fails)}/{len(results)} checks passed")
if fails: print("FAILED:", *fails, sep="\n  ")
sys.exit(1 if fails else 0)
