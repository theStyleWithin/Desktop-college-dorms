import MicButton from "./MicButton";

/** What the 3D viewer needs from the chat to let you talk to her without leaving the scene. */
export interface Talk {
  draft: string;
  setDraft: (v: string) => void;
  send: (text: string) => void;
  busy: boolean;
  onHeard: (text: string, autoSend: boolean) => void;
  onListening: (on: boolean) => void;
}

/** A see-through message bar along the bottom of the big viewer: type, or tap the mic and speak. */
export default function TalkBar({ talk }: { talk: Talk }) {
  const submit = () => { const t = talk.draft.trim(); if (t && !talk.busy) talk.send(t); };
  return (
    <form className="talkbar" onSubmit={(e) => { e.preventDefault(); submit(); }} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <input
        type="text" value={talk.draft} autoComplete="off" aria-label="Say something"
        placeholder={talk.busy ? "She's thinking…" : "Say something…"}
        onChange={(e) => talk.setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key !== "Escape") e.stopPropagation(); }}
      />
      <MicButton disabled={talk.busy} onText={talk.onHeard} onListening={talk.onListening} />
      <button type="submit" className="btn send" disabled={talk.busy || !talk.draft.trim()} aria-label="Send">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" /></svg>
      </button>
    </form>
  );
}
