// Dev-only harness (not part of the production build): runs the recorder in a plain browser page so the audio pipeline
// can be tested with a fake microphone. Exposes window.__rec() which records until auto-stop and returns what it got.
import { startRecording } from "../lib/voice";

(window as unknown as { __rec: () => Promise<unknown> }).__rec = async () => {
  const t0 = performance.now();
  let why = "";
  let levels = 0;
  const r = await new Promise<Awaited<ReturnType<typeof startRecording>>>((resolve, reject) => {
    startRecording({ onLevel: () => { levels++; }, onAutoStop: (w) => { why = w; } }).then(resolve, reject);
  });
  while (!why) await new Promise((x) => setTimeout(x, 100));
  const take = await r.stop();
  const dv = new DataView(take.wav.buffer);
  const tag = (o: number) => String.fromCharCode(...take.wav.slice(o, o + 4));
  let peak = 0;
  for (let i = 44; i + 1 < take.wav.length; i += 2) peak = Math.max(peak, Math.abs(dv.getInt16(i, true)));
  return { why, heard: take.heardSpeech, seconds: +take.seconds.toFixed(2), wallSeconds: +((performance.now() - t0) / 1000).toFixed(2), riff: tag(0), wave: tag(8), rate: dv.getUint32(24, true), bits: dv.getUint16(34, true), bytes: take.wav.length, peak, levels };
};
document.getElementById("out")!.textContent = "ready";
