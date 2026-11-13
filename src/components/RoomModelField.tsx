import { useRef, useState } from "react";
import { api, type PackageModel } from "../api";
import { importUnityPackage } from "../lib/unityPackage";
import { errText } from "../lib/util";
import { fmtBytes as sizeText } from "../lib/util";

export interface ModelDraft { file?: File; remove?: boolean; scale: number; rot: number; y: number; share: boolean }

/**
 * Import a 3D scene (.glb, .gltf or .fbx) as this room, set its size, turn and height, and say whether it may be shared.
 * Sharing is the owner's word: only a model marked "May be shared" goes into an exported profile.
 */
export default function RoomModelField({ name, draft, onChange }: { name: string; draft: ModelDraft; onChange: (d: ModelDraft) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState("");
  const [caution, setCaution] = useState("");
  const [working, setWorking] = useState("");   // what is happening while a Unity package is being opened
  const [choices, setChoices] = useState<{ models: PackageModel[]; done: (m: PackageModel | null) => void } | null>(null);
  const has = !!name && !draft.remove;
  return (
    <div className="field" data-testid="room-model">
      <span>3D room model (optional)</span>
      <div className="row" style={{ gap: 8 }}>
        <span className="music-chip" data-testid="model-name">{has ? `🏠 ${name}` : "Built-in 3D room"}</span>
        <button type="button" className="btn" disabled={!!working} onClick={() => ref.current?.click()}>{has ? "Change model" : "Import a 3D model"}</button>
        {has && <button type="button" className="btn ghost" onClick={() => onChange({ ...draft, file: undefined, remove: true })}>Remove</button>}
        {/* no `accept` filter: some pickers hide .fbx and .glb; the app checks the file itself */}
        <input ref={ref} type="file" hidden aria-label="3D room model"
          onChange={(e) => {
            const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
            const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
            // say so now rather than when saving
            if (ext === "unitypackage") {
              // open the package and turn the room in it into a .glb the app can import
              setProblem(""); setCaution(""); setWorking("Starting…");
              void importUnityPackage(f, setWorking, (models) => new Promise((done) => setChoices({ models, done: (m) => { setChoices(null); done(m); } })))
                .then((glb) => { if (glb) onChange({ file: glb, scale: 1, rot: 0, y: 0, share: false }); })
                .catch((err) => setProblem(errText(err)))
                .finally(() => setWorking(""));
              return;
            }
            if (!["glb", "gltf", "fbx"].includes(ext)) {
              setProblem("A 3D room has to be a .glb, .gltf, .fbx or .unitypackage file.");
              return;
            }
            setProblem(""); setCaution("");
            // is there room for it on this device? (refuse if it can't fit, warn if it would leave very little)
            void api.diskSpace().then(({ free, total }) => {
              const spare = 200 * 1024 * 1024;
              if (free > 0 && free < f.size + spare) {
                setProblem(`There isn't enough free space for this file: it is ${sizeText(f.size)} and this device has ${sizeText(free)} free. Free some space, or try a smaller room.`);
                return;
              }
              if (free > 0 && (free - f.size < 2 * 1024 ** 3 || (total > 0 && (free - f.size) / total < 0.05))) {
                setCaution(`This file is ${sizeText(f.size)} and would leave only ${sizeText(free - f.size)} free on this device. You may want to free some space, or pick a smaller room.`);
              }
              onChange({ file: f, scale: 1, rot: 0, y: 0, share: false });
            }).catch(() => onChange({ file: f, scale: 1, rot: 0, y: 0, share: false }));
          }} />
      </div>
      {working && <div className="hint" role="status" data-testid="package-status">{working} Big packages take a while, please stay on this page.</div>}
      {choices && (
        <div className="field" data-testid="package-choices" style={{ margin: "8px 0" }}>
          <span>This package has several models. Which one is the room?</span>
          <div className="who-list" style={{ maxHeight: 240, overflow: "auto" }}>
            {choices.models.map((m, i) => (
              <button key={m.guid} type="button" data-pick={m.name} className={i === 0 ? "on" : ""} onClick={() => choices.done(m)}>
                <span className="grow">{m.name}<span className="hint"> · {m.path}</span></span><span>{sizeText(m.size)}</span>
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 8 }}><button type="button" className="btn ghost" onClick={() => choices.done(null)}>Cancel</button></div>
          <div className="hint">Models are listed biggest first. A room is usually the biggest one; the others are often furniture and props.</div>
        </div>
      )}
      {caution && !problem && <div className="hint" role="status" data-testid="model-caution" style={{ color: "var(--warn, #e0a030)" }}>{caution}</div>}
      {problem && <div className="hint" role="alert" data-testid="model-problem" style={{ color: "var(--danger)" }}>{problem}</div>}
      <div className="hint">A house or room model as a <b>.glb</b>, <b>.gltf</b> or <b>.fbx</b> file, or a Unity package (<b>.unitypackage</b>, for example from Booth or other shops: the room model is taken out of it and its pictures put back on). A package that is too big, or has no single room model in it, is refused with the reason. It replaces the built-in room when you are in a chat set in this room. She walks around the floor it has and steps around its furniture. Models stay on this device.</div>
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
