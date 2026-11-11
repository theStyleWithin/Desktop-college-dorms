// Dev-only harness (not part of the production build): renders the 3D viewer in a plain browser page so poses and
// behaviour can be iterated on without rebuilding the app. Usage: /viewer-dev.html?src=<vrm url>&large=1&talk=1
// With talk=1 it also shows the message bar, and streams a fake reply word by word into the speech balloon after you send.
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import "../styles.css";
import VrmViewer from "../components/VrmViewer";
import type { Speech } from "../components/SpeechBubble";
import type { Wardrobe } from "../components/WardrobePanel";

const REPLY = "*waves a little* Oh, hi! I was just thinking about you. Did you eat something today? You always forget, so I made coffee. Sit with me for a bit, okay? I want to hear everything about your day.";

function Harness() {
  const q = new URLSearchParams(location.search);
  const [url, setUrl] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [speech, setSpeech] = useState<Speech | null>(null);
  const timer = useRef<number>(0);
  // a fake wardrobe (wardrobe=1): outfits live in this page only, to try the panel without the app
  const [outfits, setOutfits] = useState([{ id: "a", name: "Summer dress" }]);
  const [worn, setWorn] = useState<string | null>(null);
  const wardrobe: Wardrobe = { outfits, current: worn, onSwitch: setWorn, onAdd: (f) => setOutfits((o) => [...o, { id: "n" + o.length, name: f.name.replace(/\.[^.]+$/, "") }]),
    onRename: (id, name) => setOutfits((o) => o.map((x) => (x.id === id ? { ...x, name } : x))), onRemove: (id) => { setOutfits((o) => o.filter((x) => x.id !== id)); setWorn((w) => (w === id ? null : w)); } };
  useEffect(() => {
    fetch(q.get("src") ?? "").then((r) => r.blob()).then((b) => setUrl(URL.createObjectURL(b))).catch(() => {});
    return () => clearInterval(timer.current);
  }, []);
  const send = () => {
    setDraft(""); setBusy(true);
    const words = REPLY.split(" "); let n = 0;
    setSpeech({ id: "r" + Date.now(), text: "", streaming: true });
    const id = "r" + Date.now();
    timer.current = window.setInterval(() => {
      n++;
      if (n >= words.length) { clearInterval(timer.current); setBusy(false); setSpeech({ id: id + ":0", text: words.join(" "), streaming: false }); return; }
      setSpeech({ id, text: words.slice(0, n).join(" "), streaming: true });
    }, 180);
  };
  return (
    <div className="vrm-big" style={{ width: "100vw", height: "100vh" }}>
      {url && <VrmViewer url={url} large={q.get("large") !== "0"} speech={speech} wardrobe={q.get("wardrobe") ? wardrobe : undefined}
        talk={q.get("talk") ? { draft, setDraft, send: () => send(), busy, onHeard: (t) => setDraft(t), onListening: () => {} } : undefined} />}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
