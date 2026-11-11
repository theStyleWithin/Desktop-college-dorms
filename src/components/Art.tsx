import { lazy, Suspense, useEffect, useState } from "react";
import ViewerWindow from "./ViewerWindow";
import type { Speech } from "./SpeechBubble";
import type { Talk } from "./TalkBar";
import type { Wardrobe } from "./WardrobePanel";
import type { Frame, MediaKind } from "../api";
import { hue, initials } from "../lib/util";

const VrmViewer = lazy(() => import("./VrmViewer"));

interface Props {
  kind: MediaKind | null;
  url: string | null;
  name: string;
  /** Where the picture is framed (position + zoom) so a face stays in view whatever shape it is shown in. */
  frame?: Frame | null;
  /** `thumb` keeps lists light (no WebGL, videos play on hover); `full` shows the live model. */
  mode?: "thumb" | "full";
  /** Someone is talking to her right now (typing or waiting for a reply), so a 3D character stops her own routine and pays attention. */
  attentive?: boolean;
  /** What a 3D character is saying right now (shown as a manga-style balloon), and how to talk back from the big viewer. */
  speech?: Speech | null;
  talk?: Talk;
  /** The character's outfits: adds the wardrobe button to the 3D viewer. */
  wardrobe?: Wardrobe;
}

/**
 * WebKitGTK can't stream media from Tauri's custom `asset://` scheme (the
 * element fails with MEDIA_ERR_SRC_NOT_SUPPORTED), so videos are fetched into a
 * Blob and played from a `blob:` URL. In lists that only happens on hover.
 */
/** CSS that keeps the chosen point of a picture in view and zooms in on it. */
export function frameStyle(f?: Frame | null): React.CSSProperties | undefined {
  if (!f) return undefined;
  const o = `${(f.x * 100).toFixed(2)}% ${(f.y * 100).toFixed(2)}%`;
  return { objectPosition: o, transformOrigin: o, transform: f.zoom > 1 ? `scale(${f.zoom})` : undefined };
}

function VideoArt({ url, full, bg, name, frame }: { url: string; full: boolean; bg: string; name: string; frame?: Frame | null }) {
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
      {src ? <video src={src} muted loop playsInline autoPlay style={frameStyle(frame)} /> : <span className="ph">{initials(name)}</span>}
      <span className="badge">{src ? "VIDEO" : "▶ VIDEO"}</span>
    </div>
  );
}

/** The small live 3D panel, with a button that opens the big viewer. */
function VrmStage({ url, name, bg, attentive, speech, talk, wardrobe }: { url: string; name: string; bg: string; attentive?: boolean; speech?: Speech | null; talk?: Talk; wardrobe?: Wardrobe }) {
  const [big, setBig] = useState(false);
  return (
    <div className="media" data-big={big ? "1" : "0"} style={{ background: bg }}>
      <Suspense fallback={<span className="ph">…</span>}>{!big && <VrmViewer url={url} attentive={attentive} speech={speech} wardrobe={wardrobe} onExpand={() => setBig(true)} />}</Suspense>
      {big && <span className="ph" style={{ fontSize: "1rem" }}>Open in the big viewer</span>}
      {big && (
        <ViewerWindow title={`${name || "3D model"}`} onClose={() => setBig(false)}>
          <div className="vrm-big"><Suspense fallback={<span className="ph">…</span>}><VrmViewer url={url} large attentive={attentive} speech={speech} talk={talk} wardrobe={wardrobe} /></Suspense></div>
        </ViewerWindow>
      )}
    </div>
  );
}

export default function Art({ kind, url, name, frame, mode = "thumb", attentive, speech, talk, wardrobe }: Props) {
  const bg = `linear-gradient(135deg, hsl(${hue(name)} 45% 35%), hsl(${(hue(name) + 50) % 360} 50% 22%))`;

  if (!url || !kind) {
    return (
      <div className="media" style={{ background: bg }}>
        <span className="ph">{initials(name)}</span>
      </div>
    );
  }
  if (kind === "vrm") {
    if (mode === "full") return <VrmStage url={url} name={name} bg={bg} attentive={attentive} speech={speech} talk={talk} wardrobe={wardrobe} />;
    return (
      <div className="media" style={{ background: bg }}>
        <span className="ph">{initials(name)}</span>
        <span className="badge">3D · VRM</span>
      </div>
    );
  }
  if (kind === "video") return <VideoArt url={url} full={mode === "full"} bg={bg} name={name} frame={frame} />;
  return (
    <div className="media">
      <img src={url} alt={name} loading="lazy" draggable={false} style={frameStyle(frame)} />
      {kind === "gif" && <span className="badge">GIF</span>}
    </div>
  );
}
