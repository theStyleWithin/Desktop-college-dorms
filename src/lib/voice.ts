/**
 * Voice input: records the microphone and returns a 16 kHz mono 16-bit WAV, which every speech-to-text server accepts.
 * (MediaRecorder codecs differ between WebKitGTK, WebView2 and Android's WebView, raw PCM works everywhere.)
 * A simple voice-activity check ends the recording a moment after you stop talking.
 */
export interface Recording { wav: Uint8Array; seconds: number; heardSpeech: boolean }
export interface Recorder {
  /** Ends the recording and returns it. */
  stop(): Promise<Recording>;
  /** Throws the recording away. */
  cancel(): void;
}

export function micErrorText(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access was blocked. Allow the microphone for this app in your system settings, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. Plug one in (or pick one in your system sound settings) and try again.";
  if (name === "NotReadableError") return "The microphone is busy in another app. Close it there and try again.";
  return e instanceof Error ? e.message : String(e);
}

export async function startRecording(opts: {
  /** 0..1 input level, about 10 times a second (drives the little meter) */
  onLevel?: (level: number) => void;
  /** Called once when speech was heard and then stopped, or when nothing was said for a while. */
  onAutoStop?: (why: "silence" | "nothing" | "limit") => void;
  maxSeconds?: number;
}): Promise<Recorder> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Voice input isn't available in this window (the system webview has no microphone support).");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0; // the processor only runs while connected to the output, but we don't want to hear ourselves
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);

  const chunks: Float32Array[] = [];
  let heard = false, lastSpeech = 0, floor = 0.01, fired = false, done = false;
  const t0 = performance.now();
  const maxMs = (opts.maxSeconds ?? 60) * 1000;
  const fire = (why: "silence" | "nothing" | "limit") => { if (!fired && !done) { fired = true; opts.onAutoStop?.(why); } };

  proc.onaudioprocess = (ev) => {
    if (done) return;
    const data = new Float32Array(ev.inputBuffer.getChannelData(0));
    chunks.push(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const now = performance.now() - t0;
    // the noise floor follows the quietest recent level; speech is clearly above it
    floor = rms < floor ? rms : floor + (rms - floor) * 0.02;
    const speaking = rms > Math.max(0.02, floor * 3.2);
    if (speaking) { heard = true; lastSpeech = now; }
    opts.onLevel?.(Math.min(1, rms * 8));
    if (heard && now - lastSpeech > 1700) fire("silence");
    else if (!heard && now > 9000) fire("nothing");
    else if (now > maxMs) fire("limit");
  };

  const release = () => {
    done = true;
    try { proc.disconnect(); src.disconnect(); mute.disconnect(); } catch { /* already gone */ }
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
  };

  return {
    async stop() {
      const rate = ctx.sampleRate;
      release();
      let n = 0;
      for (const c of chunks) n += c.length;
      const all = new Float32Array(n);
      let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      return { wav: encodeWav(downsample(all, rate, 16000), 16000), seconds: n / rate, heardSpeech: heard };
    },
    cancel() { release(); },
  };
}

/** Box-filter downsampling (good enough for speech). */
export function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (to >= from) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio), b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let k = a; k < b; k++) s += input[k];
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}

export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Uint8Array(buf);
}
