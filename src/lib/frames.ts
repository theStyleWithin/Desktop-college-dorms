/** Turns a picture, a gif or a video into a few still pictures (JPEG data URLs) that a model which can see pictures can be sent. */
const MAX_SIDE = 1280;
export const MAX_FILES = 4;
export const FILE_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.bmp,.mp4,.webm,.mov,.m4v,image/*,video/*";

export type Opened = { frames: string[]; note: string };

export const kindOfFile = (f: File): "image" | "gif" | "video" | null => {
  const n = f.name.toLowerCase();
  if (n.endsWith(".gif") || f.type === "image/gif") return "gif";
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(n) || f.type.startsWith("video/")) return "video";
  if (/\.(png|jpe?g|webp|avif|bmp)$/.test(n) || f.type.startsWith("image/")) return "image";
  return null;
};

function draw(src: CanvasImageSource, w: number, h: number): string {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext("2d");
  if (!g) throw new Error("This device can't make a picture from that file.");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.82);
}

const once = (el: HTMLElement, ok: string, ms: number) => new Promise<void>((res, rej) => {
  const t = window.setTimeout(() => rej(new Error("It took too long to read.")), ms);
  el.addEventListener(ok, () => { window.clearTimeout(t); res(); }, { once: true });
  el.addEventListener("error", () => { window.clearTimeout(t); rej(new Error("This device can't read that file.")); }, { once: true });
});

export async function framesOf(file: File): Promise<Opened> {
  const kind = kindOfFile(file);
  if (!kind) throw new Error("That kind of file isn't supported. Use a png, jpg, webp, gif or a video (mp4 or webm).");
  if (file.size > (kind === "video" ? 60 : 20) * 1024 * 1024) throw new Error(`“${file.name}” is too big (${kind === "video" ? "60" : "20"} MB at most).`);
  const url = URL.createObjectURL(file);
  try {
    if (kind !== "video") {
      const img = new Image();
      img.src = url;
      await once(img, "load", 15000);
      return { frames: [draw(img, img.naturalWidth || 1, img.naturalHeight || 1)], note: kind === "gif" ? `Sent the first frame of “${file.name}” (a gif is shown as one still).` : `Sent “${file.name}”.` };
    }
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
    await once(v, "loadeddata", 15000);
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const times = dur ? [0.08, 0.33, 0.58, 0.83].map((p) => p * dur) : [0];
    const frames: string[] = [];
    for (const t of times) {
      if (dur) { const done = once(v, "seeked", 8000); v.currentTime = t; await done; }
      frames.push(draw(v, v.videoWidth || 1, v.videoHeight || 1));
    }
    return { frames, note: `Sent ${frames.length} still frame${frames.length === 1 ? "" : "s"} from “${file.name}” (stills only: no sound, no motion).` };
  } finally { URL.revokeObjectURL(url); }
}
