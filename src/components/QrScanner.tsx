import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

/** Looks through the camera for a QR code and hands back what it says. Stops the camera when it finds one or is closed. */
export default function QrScanner({ onResult, onCancel }: { onResult: (text: string) => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState("");
  const cb = useRef(onResult);
  cb.current = onResult;
  useEffect(() => {
    let stop = false;
    let stream: MediaStream | null = null;
    let timer = 0;
    const canvas = document.createElement("canvas");
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
        if (stop) { stream.getTracks().forEach((t) => t.stop()); return; }
        const v = video.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play();
        const tick = () => {
          if (stop) return;
          if (v.videoWidth) {
            canvas.width = v.videoWidth; canvas.height = v.videoHeight;
            const g = canvas.getContext("2d", { willReadFrequently: true });
            if (g) {
              g.drawImage(v, 0, 0);
              const img = g.getImageData(0, 0, canvas.width, canvas.height);
              const r = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
              if (r?.data) { stop = true; stream?.getTracks().forEach((t) => t.stop()); cb.current(r.data); return; }
            }
          }
          timer = window.setTimeout(tick, 150);
        };
        tick();
      } catch {
        setErr("I couldn't open the camera. It may be blocked, busy or missing. You can type the address and code instead.");
      }
    })();
    return () => { stop = true; window.clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);
  return (
    <div className="card" data-testid="qr-scanner" style={{ display: "grid", gap: 8 }}>
      {err ? <div className="banner">{err}</div> : <video ref={video} muted playsInline style={{ width: "100%", maxHeight: 320, borderRadius: 10, background: "#000" }} />}
      <div className="hint">Point the camera at the code on the other device's screen.</div>
      <button className="btn" onClick={onCancel}>Cancel</button>
    </div>
  );
}
