import { useCallback, useEffect, useState } from "react";
import { api, onGen, type ChatPlaybook, type PbValue, type Playbook } from "../api";
import { Modal, useToast } from "./ui";
import { errText } from "../lib/util";
import { useStore } from "../store";

function ValueRow({ v, onSet }: { v: PbValue; onSet: (x: unknown) => void }) {
  const val = v.value;
  return (
    <div className="pb-val" data-val={v.id}>
      <div className="row"><b className="grow">{v.label || v.id}</b>
        {v.kind === "number" && <input type="number" aria-label={`${v.label || v.id}`} style={{ width: 80 }} value={Number(val ?? 0)} min={v.min ?? undefined} max={v.max ?? undefined} onChange={(e) => onSet(Number(e.target.value))} />}
        {v.kind === "bool" && <label className="switch"><input type="checkbox" role="switch" aria-label={`${v.label || v.id}`} checked={!!val} onChange={(e) => onSet(e.target.checked)} /><i /></label>}
        {v.kind === "choice" && <select aria-label={`${v.label || v.id}`} value={String(val ?? "")} onChange={(e) => onSet(e.target.value)}>{v.options.map((o) => <option key={o}>{o}</option>)}</select>}
        {v.kind === "text" && <input type="text" aria-label={`${v.label || v.id}`} maxLength={80} defaultValue={String(val ?? "")} key={String(val)} onBlur={(e) => e.target.value !== String(val ?? "") && onSet(e.target.value)} />}
      </div>
      {v.meaning && <small>Right now: {v.meaning}</small>}
      {v.note && <small className="hint">{v.note}</small>}
    </div>
  );
}

/** The story of one chat: which playbook runs, its values as they stand, and a way to start it over. */
export default function PlaybookPanel({ chatId, onClose }: { chatId: number; onClose: () => void }) {
  const toast = useToast();
  const { go } = useStore();
  const [data, setData] = useState<ChatPlaybook | null>(null);
  const [mine, setMine] = useState<Playbook[]>([]);
  const [scenario, setScenario] = useState("");
  const load = useCallback(async () => {
    try { const [d, l] = await Promise.all([api.getChatPlaybook(chatId), api.listPlaybooks()]); setData(d); setMine(l); } catch (e) { toast(errText(e), "err"); }
  }, [chatId, toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const u = onGen((e) => { if (e.chat_id === chatId && (e.kind === "done" || e.kind === "error")) void load(); }); return () => { void u.then((f) => f()); }; }, [chatId, load]);

  const run = async (fn: () => Promise<ChatPlaybook>) => { try { setData(await fn()); } catch (e) { toast(errText(e), "err"); } };
  if (!data) return <Modal title="Playbook" onClose={onClose} wide><div className="hint">Loading…</div></Modal>;
  const choice = data.mode === "set" ? `set:${data.selected ?? ""}` : data.mode;
  const pb = data.active;
  const pick = (v: string) => {
    if (v === "inherit" || v === "none") return run(() => api.setChatPlaybook(chatId, v, null, null));
    return run(() => api.setChatPlaybook(chatId, "set", v.slice(4), scenario || null));
  };
  return (
    <Modal title="Playbook" onClose={onClose} wide>
      <div data-testid="playbook-panel">
        <p className="sub">A playbook keeps this chat's story: values the characters are told about, and rules that change them as you talk. One runs at a time.</p>
        <label className="field"><span>Which playbook</span>
          <select aria-label="Playbook for this chat" data-testid="pb-pick" value={choice} onChange={(e) => void pick(e.target.value)}>
            <option value="inherit">{data.from_world ? "The world's" : "The character's own"}{data.from_character ? "" : " (none)"}</option>
            <option value="none">None for this chat</option>
            {mine.map((p) => <option key={p.id} value={`set:${p.id}`}>{p.name}</option>)}
          </select></label>
        {pb && pb.scenarios.length > 0 && (
          <label className="field"><span>Starting scenario (applies when you choose it)</span>
            <select aria-label="Starting scenario" value={scenario} onChange={(e) => { setScenario(e.target.value); void run(() => api.setChatPlaybook(chatId, data.mode === "inherit" ? "inherit" : "set", data.selected, e.target.value || null)); }}>
              <option value="">As the playbook begins</option>
              {pb.scenarios.map((s) => <option key={s.name} value={s.name}>{s.name}{s.description ? ` — ${s.description}` : ""}</option>)}
            </select></label>
        )}
        {pb ? (
          <>
            <h4 style={{ margin: "12px 0 4px" }}>{pb.name} <small className="tok">turn {data.turn}</small></h4>
            {pb.instructions && <p className="hint">{pb.instructions}</p>}
            <div className="pb-hud">{data.values.map((v) => <ValueRow key={v.id} v={v} onSet={(x) => void run(() => api.setPlaybookValues(chatId, { [v.id]: x }))} />)}
              {!data.values.length && <div className="hint">This playbook has no values yet.</div>}</div>
            {pb.rules.some((r) => r.ask.trim()) && (
              <label className="check" style={{ display: "flex", gap: 8, margin: "10px 0" }}>
                <input type="checkbox" checked={data.llm} onChange={(e) => void run(() => api.setPlaybookLlm(chatId, e.target.checked))} />
                <span>Let the model judge the rules that ask it a question<small className="muted" style={{ display: "block" }}>Each one is an extra request to your model after a reply. Switched off, those rules use their plain fallback checks, or don't run.</small></span>
              </label>
            )}
          </>
        ) : <p className="hint" style={{ marginTop: 12 }}>No playbook is running in this chat.</p>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => { onClose(); go({ page: "playbooks", edit: pb?.id }); }}>{pb ? "Edit this playbook" : "Open Playbooks"}</button>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>↻ Regenerate replays the turn from the values before it. ⏩ Continue doesn't move the story on. Editing a message doesn't re-run the rules.</p>
      </div>
    </Modal>
  );
}
