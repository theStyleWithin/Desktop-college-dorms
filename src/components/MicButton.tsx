import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { errText } from "../lib/util";
import { micErrorText, startRecording, type Recorder } from "../lib/voice";
import { useToast } from "./ui";

/**
 * The 🎤 button: tap to start listening, it stops by itself a moment after you stop talking (or tap again to finish
 * early), then the recording is turned into text by the server chosen in Settings → Voice.
 */
export default function MicButton({ disabled, onText, onListening }: {
  disabled?: boolean;
  /** What was said, and whether Settings says to send it straight away. */
  onText: (text: string, autoSend: boolean) => void;
  /** True while the microphone is open (the 3D character looks up and pays attention). */
  onListening?: (on: boolean) => void;
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<"idle" | "starting" | "listening" | "transcribing">("idle");
  const [level, setLevel] = useState(0);
  const rec = useRef<Recorder | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const cb = useRef({ onText, onListening });
  cb.current = { onText, onListening };

  useEffect(() => () => { rec.current?.cancel(); cb.current.onListening?.(false); }, []);

  const finish = async (why: "tap" | "silence" | "nothing" | "limit") => {
    const r = rec.current;
    if (!r || phaseRef.current !== "listening") return;
    rec.current = null;
    cb.current.onListening?.(false);
    setLevel(0);
    const take = await r.stop();
    if (!take.heardSpeech || take.seconds < 0.4) {
      setPhase("idle");
      if (why !== "tap" || take.seconds >= 0.4) toast("I didn't hear anything. Check your microphone and try again.", "info");
      return;
    }
    setPhase("transcribing");
    try {
      const [text, s] = await Promise.all([api.transcribe(take.wav), api.getSettings()]);
      if (!text.trim()) toast("I couldn't make out any words. Try again a little closer to the mic.", "info");
      else cb.current.onText(text.trim(), s.stt_auto_send);
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setPhase("idle");
    }
  };

  const click = async () => {
    if (phase === "listening") return finish("tap");
    if (phase !== "idle" || disabled) return;
    setPhase("starting");
    try {
      rec.current = await startRecording({ onLevel: setLevel, onAutoStop: (why) => void finish(why) });
      setPhase("listening");
      cb.current.onListening?.(true);
    } catch (e) {
      rec.current = null;
      setPhase("idle");
      toast(micErrorText(e), "err");
    }
  };

  const label = phase === "listening" ? "Stop listening" : phase === "transcribing" ? "Transcribing" : "Voice input";
  return (
    <button type="button" className={`btn mic ${phase}`} onClick={click} disabled={disabled && phase === "idle"} aria-label={label} data-phase={phase}
      title={phase === "listening" ? "Listening… tap to finish (it also stops when you stop talking)" : phase === "transcribing" ? "Turning your voice into text…" : "Talk to her: tap, speak, and she'll hear you"}>
      {phase === "transcribing" ? <span className="mic-dots" aria-hidden="true">…</span> : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v4" />
        </svg>
      )}
      {phase === "listening" && <span className="mic-level" style={{ transform: `scale(${1 + level * 0.9})`, opacity: 0.25 + level * 0.5 }} aria-hidden="true" />}
    </button>
  );
}
