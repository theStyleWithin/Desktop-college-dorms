// Dev-only harness (not part of the production build): renders the 3D viewer in a plain browser page so poses and
// behaviour can be iterated on without rebuilding the app. Usage: /viewer-dev.html?src=<vrm url>&large=1
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import "../styles.css";
import VrmViewer from "../components/VrmViewer";

function Harness() {
  const q = new URLSearchParams(location.search);
  const [url, setUrl] = useState("");
  useEffect(() => {
    fetch(q.get("src") ?? "").then((r) => r.blob()).then((b) => setUrl(URL.createObjectURL(b))).catch(() => {});
  }, []);
  return (
    <div className="vrm-big" style={{ width: "100vw", height: "100vh" }}>
      {url && <VrmViewer url={url} large={q.get("large") !== "0"} />}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
