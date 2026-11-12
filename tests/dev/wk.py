import sys, time, subprocess, os
from selenium import webdriver
from selenium.webdriver.common.options import ArgOptions
mb = "/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser"
o = ArgOptions(); o.set_capability("browserName", "MiniBrowser"); o.set_capability("webkitgtk:browserOptions", {"binary": mb, "args": ["--automation"]})
drv = subprocess.Popen(["WebKitWebDriver", "--port=4455"])
time.sleep(2)
try:
    d = webdriver.Remote("http://127.0.0.1:4455", options=o)
    url = "http://localhost:5199/viewer-dev.html?src=" + "http%3A%2F%2F127.0.0.1%3A8099%2Fm.vrm" + sys.argv[1]
    d.get(url)
    d.execute_script("window.__errs=[];window.addEventListener('error',e=>window.__errs.push(String(e.message)+' @'+e.lineno));window.addEventListener('unhandledrejection',e=>window.__errs.push('rej '+String(e.reason)))")
    ok = False
    for _ in range(80):
        if d.execute_script("const e=document.querySelector('.vrm-box');return !!e&&e.dataset.ready==='1'"): ok = True; break
        time.sleep(0.5)
    print("ready:", ok, d.execute_script("return JSON.stringify(window.__errs)"), d.execute_script("const e=document.querySelector('.vrm-box');return e?JSON.stringify(e.dataset):'nobox'")[:300])
    print(d.execute_script("return document.body.innerText.slice(0,200)"))
finally:
    try: d.quit()
    except Exception: pass
    drv.terminate()
