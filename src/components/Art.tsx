import { lazy, Suspense, useEffect, useState } from "react";
import type { MediaKind } from "../api";
import { hue, initials } from "../lib/util";

const VrmViewer = lazy(() => import("./VrmViewer"));

interface Props {
  kind: MediaKind | null;
  url: string | null;
  name: string;
  /** `thumb` keeps lists light (no WebGL, videos play on hover); `full` shows the live model. */
  mode?: "thumb" | "full";
}

/**
 * WebKitGTK can't stream media from Tauri's custom `asset://` scheme (the
 * element fails with MEDIA_ERR_SRC_NOT_SUPPORTED), so videos are fetched into a
 * Blob and played from a `blob:` URL. In lists that only happens on hover.
 */
function VideoArt({ url, full, bg, name }: { url: string; full: boolean; bg: string; name: string }) {
  const [active, setActive] = useState(full);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!active) { setSrc(null); return; }
    let alive = true;
    let obj: string | null = null;
    const webm = /\.(webm|ogv)(\?|$)/i.test(decodeURIComponent(url));
    fetch(url)
      .then((r) => r.blob())
      .then((b) => {
        if (!alive) return;
        obj = URL.createObjectURL(new Blob([b], { type: webm ? "video/webm" : "video/mp4" }));
        setSrc(obj);
      })
      .catch(() => {});
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
  }, [active, url]);

  return (
    <div className="media" style={src ? undefined : { background: bg }}
      onMouseEnter={() => !full && setActive(true)} onMouseLeave={() => !full && setActive(false)}>
      {src ? <video src={src} muted loop playsInline autoPlay /> : <span className="ph">{initials(name)}</span>}
      <span className="badge">{src ? "VIDEO" : "▶ VIDEO"}</span>
    </div>
  );
}

export default function Art({ kind, url, name, mode = "thumb" }: Props) {
  const bg = `linear-gradient(135deg, hsl(${hue(name)} 45% 35%), hsl(${(hue(name) + 50) % 360} 50% 22%))`;

  if (!url || !kind) {
    return (
      <div className="media" style={{ background: bg }}>
        <span className="ph">{initials(name)}</span>
      </div>
    );
  }
  if (kind === "vrm") {
    if (mode === "full") {
      return (
        <div className="media" style={{ background: bg }}>
          <Suspense fallback={<span className="ph">…</span>}><VrmViewer url={url} /></Suspense>
        </div>
      );
    }
    return (
      <div className="media" style={{ background: bg }}>
        <span className="ph">{initials(name)}</span>
        <span className="badge">3D · VRM</span>
      </div>
    );
  }
  if (kind === "video") return <VideoArt url={url} full={mode === "full"} bg={bg} name={name} />;
  return (
    <div className="media">
      <img src={url} alt={name} loading="lazy" draggable={false} />
      {kind === "gif" && <span className="badge">GIF</span>}
    </div>
  );
}
