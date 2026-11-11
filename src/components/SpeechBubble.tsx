import { forwardRef, useEffect, useMemo, useState } from "react";

export interface Speech { id: string; text: string; streaming: boolean }

const PAGE = 150;

/** Cuts a reply into bubble-sized pages at sentence boundaries. */
export function pages(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?…。！？])\s+/);
  const out: string[] = [];
  let cur = "";
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  for (let s of sentences) {
    while (s.length > PAGE * 1.4) { // one huge sentence: break it at a space
      const cut = s.lastIndexOf(" ", PAGE);
      const at = cut > PAGE * 0.4 ? cut : PAGE;
      if (cur) push();
      out.push(s.slice(0, at).trim()); s = s.slice(at).trim();
    }
    if ((cur + " " + s).trim().length > PAGE) push();
    cur = (cur + " " + s).trim();
  }
  push();
  return out;
}

/** *actions* are drawn smaller and slanted, the way manga puts narration beside speech. */
function renderBubbleText(t: string) {
  return t.split(/(\*[^*]+\*)/g).filter(Boolean).map((p, i) =>
    p.startsWith("*") && p.endsWith("*") && p.length > 2 ? <span className="act" key={i}>{p.slice(1, -1)}</span> : <span key={i}>{p.replace(/\*/g, "")}</span>);
}

/**
 * A manga-style speech balloon: white, thick outline, hard shadow and a tail, that pops in above the character's head
 * and reveals what she says as it is written. Long replies are shown a page at a time (tap to move on). The 3D viewer
 * positions it every frame (through the ref) so the tail always points at her.
 */
const SpeechBubble = forwardRef<HTMLDivElement, { speech: Speech | null; small?: boolean }>(function SpeechBubble({ speech, small }, ref) {
  const [page, setPage] = useState(0);
  const [hidden, setHidden] = useState(false);
  const ps = useMemo(() => pages(speech?.text ?? ""), [speech?.text]);

  useEffect(() => { setPage(0); setHidden(false); }, [speech?.id]);
  // while it is being written, stay on the newest page; once it is finished, start from the first page so nothing is missed
  useEffect(() => { if (speech && !speech.streaming) setPage(0); }, [speech?.streaming, speech?.id]);
  useEffect(() => {
    if (!speech) return;
    if (speech.streaming) { setPage(Math.max(0, ps.length - 1)); return; }
    const last = page >= ps.length - 1;
    const t = setTimeout(() => { if (last) setHidden(true); else setPage((p) => p + 1); }, Math.max(2600, (ps[page]?.length ?? 0) * 62) + (last ? 3500 : 0));
    return () => clearTimeout(t);
  }, [speech?.streaming, speech?.id, ps, page]);

  const show = !!speech && !hidden;
  const text = ps[Math.min(page, Math.max(0, ps.length - 1))] ?? "";
  const more = !!speech && !speech.streaming && page < ps.length - 1;
  return (
    <div ref={ref} className={`manga${small ? " small" : ""}${show ? "" : " off"}`} data-state={!show ? "off" : speech?.streaming ? "writing" : "done"} role="status" aria-live="polite"
      onClick={() => { if (more) setPage((p) => p + 1); else setHidden(true); }} title="Click to continue">
      <div className="balloon" key={speech?.id}>
        {text ? renderBubbleText(text) : <span className="dots" aria-label="She is thinking"><i /><i /><i /></span>}
        {speech?.streaming && text && <span className="caret" aria-hidden="true" />}
        {more && <span className="more" aria-hidden="true">▼</span>}
      </div>
    </div>
  );
});
export default SpeechBubble;
