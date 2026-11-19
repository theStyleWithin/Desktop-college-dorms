import { useEffect, useState } from "react";
import { api, type NovelStatus } from "../api";
import { Modal, useToast } from "./ui";
import { errText } from "../lib/util";

const TONES = ["", "Adventure", "Slow-burn romance", "Mystery", "Cozy slice of life", "Fantasy epic", "Horror", "Comedy", "Drama"];
const POVS: [string, string][] = [["", "Whatever fits best"], ["third person, past tense", "Third person, past tense"], ["first person, past tense", "First person, past tense"], ["first person, present tense", "First person, present tense"], ["third person, present tense", "Third person, present tense"]];
const SIZES: [number, string][] = [[800, "Short (about 550 words)"], [1500, "Medium (about 1,050 words)"], [2500, "Long (about 1,750 words)"]];

/** Asks what story to write before anything is written, and how long it should be. */
export default function NovelDialog({ chatId, onClose, onStarted }: { chatId: number; onClose: () => void; onStarted: () => void }) {
  const toast = useToast();
  const [st, setSt] = useState<NovelStatus | null>(null);
  const [plot, setPlot] = useState("");
  const [tone, setTone] = useState("");
  const [pov, setPov] = useState("");
  const [chapters, setChapters] = useState(8);
  const [size, setSize] = useState(1500);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.novelStatus(chatId).then((s) => { setSt(s); if (s.plan) { setPlot(s.plan.plot); setTone(s.plan.tone); setPov(s.plan.pov); } }).catch(() => {}); }, [chatId]);
  const limit = st?.limit ?? 0;
  const left = limit > 0 ? Math.max(0, limit - (st?.used_today ?? 0) - (st?.reserve ?? 0)) : null;
  const fits = left == null ? chapters : Math.min(chapters, left);
  const start = async () => {
    setBusy(true);
    try { await api.novelStart(chatId, plot, tone, pov, chapters, size, false); onStarted(); onClose(); } catch (e) { toast(errText(e), "err"); } finally { setBusy(false); }
  };
  return (
    <Modal title="📖 Write a novel" onClose={onClose}>
      <div data-testid="novel-dialog">
        <p className="sub">The character writes a full story chapter by chapter, here in the chat. You can scroll and read at your own pace while it keeps writing, and stop it any time.</p>
        <label className="field"><span>What should the story be about? (optional)</span>
          <textarea rows={5} maxLength={2000} value={plot} placeholder="e.g. A slow-burn mystery in the old library, ending on a twist. Leave this empty to let the character choose a plot that suits the scene." onChange={(e) => setPlot(e.target.value)} data-testid="novel-plot" /></label>
        <div className="pb-row">
          <label className="field grow"><span>Tone</span><select value={TONES.includes(tone) ? tone : ""} onChange={(e) => setTone(e.target.value)} aria-label="Tone">{TONES.map((t) => <option key={t} value={t}>{t || "Let the story decide"}</option>)}</select></label>
          <label className="field grow"><span>Point of view</span><select value={pov} onChange={(e) => setPov(e.target.value)} aria-label="Point of view">{POVS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select></label>
        </div>
        <div className="pb-row">
          <label className="field"><span>Chapters</span><input type="number" min={1} max={60} value={chapters} onChange={(e) => setChapters(Math.max(1, Math.min(60, Number(e.target.value) || 1)))} aria-label="Chapters" data-testid="novel-chapters" /></label>
          <label className="field grow"><span>Length of each chapter</span><select value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Chapter length">{SIZES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select></label>
        </div>
        <p className="hint" data-testid="novel-estimate">
          One request to your model per chapter, so about {chapters} request{chapters === 1 ? "" : "s"}.
          {left != null && <> Today's allowance leaves room for {left} (limit {limit} a day, {st?.used_today ?? 0} used, {st?.reserve ?? 0} kept for chatting).{fits < chapters ? <> <b>The story will be planned as {fits} chapter{fits === 1 ? "" : "s"} so it ends properly within it.</b></> : null}</>}
          {left == null && <> No daily limit is set. If your model is free or has a daily allowance, set it under Settings → Writing so a novel is planned to fit it.</>}
        </p>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary" disabled={busy || fits === 0} onClick={() => void start()} data-testid="novel-start">Start writing</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
