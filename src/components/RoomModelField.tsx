import { useRef } from "react";

export interface ModelDraft { file?: File; remove?: boolean; scale: number; rot: number; y: number; share: boolean }

/**
 * Import a 3D scene (.glb, .gltf or .fbx) as this room, set its size, turn and height, and say whether it may be shared.
 * Sharing is the owner's word: only a model marked "May be shared" goes into an exported profile.
 */
export default function RoomModelField({ name, draft, onChange }: { name: string; draft: ModelDraft; onChange: (d: ModelDraft) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const has = !!name && !draft.remove;
  return (
    <div className="field" data-testid="room-model">
      <span>3D room model (optional)</span>
      <div className="row" style={{ gap: 8 }}>
        <span className="music-chip" data-testid="model-name">{has ? `🏠 ${name}` : "Built-in 3D room"}</span>
        <button type="button" className="btn" onClick={() => ref.current?.click()}>{has ? "Change model" : "Import a 3D model"}</button>
        {has && <button type="button" className="btn ghost" onClick={() => onChange({ ...draft, file: undefined, remove: true })}>Remove</button>}
        {/* no `accept` filter: some pickers hide .fbx and .glb; the app checks the file itself */}
        <input ref={ref} type="file" hidden aria-label="3D room model"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onChange({ file: f, scale: 1, rot: 0, y: 0, share: false }); }} />
      </div>
      <div className="hint">A house or room model as a <b>.glb</b>, <b>.gltf</b> or <b>.fbx</b> file (for example from Booth or other shops; export it from Unity or Blender if you only have a .unitypackage). It replaces the built-in room when you are in a chat set in this room. She walks around the floor it has and steps around its furniture. Models stay on this device.</div>
      {has && (
        <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
          <label className="field" style={{ margin: 0 }}><span>Size: ×{draft.scale.toFixed(2)}</span>
            <input type="range" aria-label="Model size" min={0.1} max={4} step={0.05} value={Math.min(4, Math.max(0.1, draft.scale))} onChange={(e) => onChange({ ...draft, scale: Number(e.target.value) })} />
            <div className="hint">She is about 1.6 m tall in the model's world. If she looks like a giant or a mouse, change this.</div></label>
          <label className="field" style={{ margin: 0 }}><span>Turn: {Math.round(draft.rot)}°</span>
            <input type="range" aria-label="Model turn" min={0} max={359} step={1} value={Math.round(draft.rot)} onChange={(e) => onChange({ ...draft, rot: Number(e.target.value) })} /></label>
          <label className="field" style={{ margin: 0 }}><span>Height: {draft.y.toFixed(2)} m</span>
            <input type="range" aria-label="Model height" min={-2} max={2} step={0.01} value={Math.min(2, Math.max(-2, draft.y))} onChange={(e) => onChange({ ...draft, y: Number(e.target.value) })} />
            <div className="hint">Raise or lower the model until her feet rest on the floor.</div></label>
          <div className="field" style={{ margin: 0 }}><span>Sharing</span>
            <div className="chips">
              <button type="button" className={`chip big ${!draft.share ? "on" : ""}`} aria-pressed={!draft.share} data-share="no" onClick={() => onChange({ ...draft, share: false })}>Not allowed to share</button>
              <button type="button" className={`chip big ${draft.share ? "on" : ""}`} aria-pressed={draft.share} data-share="yes" onClick={() => onChange({ ...draft, share: true })}>May be shared</button>
            </div>
            <div className="hint">Only mark it <b>May be shared</b> if the seller's terms allow passing the file on. A model that is not allowed to be shared stays out of exported profile files (the room itself is still exported). This is your own declaration; the app can't check the seller's licence.</div>
          </div>
        </div>
      )}
    </div>
  );
}
