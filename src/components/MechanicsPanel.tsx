import { useCallback, useEffect, useRef, useState } from "react";
import { api, onMechanics, type ChatMechanic, type MechanicPack } from "../api";
import { Modal, useToast } from "./ui";
import { errText } from "../lib/util";

const pct = (v: number, min = 0, max = 100) => Math.max(0, Math.min(100, ((v - min) / Math.max(1, max - min)) * 100));

function Bar({ label, value, min = 0, max = 100, color = "var(--accent)", note }: { label: string; value: number; min?: number; max?: number; color?: string; note?: string }) {
  return (
    <div className="mech-bar">
      <div className="row"><b className="grow">{label}</b><span className="tok">{Math.round(value * 10) / 10}{max ? ` / ${max}` : ""}</span></div>
      <div className="track"><i style={{ width: `${pct(value, min, max)}%`, background: color }} /></div>
      {note && <div className="hint">{note}</div>}
    </div>
  );
}

function Relations({ data }: { data: any }) {
  const chars = data?.chars && typeof data.chars === "object" ? Object.entries<any>(data.chars) : [];
  if (!chars.length) return <div className="hint">Cards appear here as characters enter the story.</div>;
  return (
    <div className="mech-cards">
      {chars.map(([id, c]) => (
        <div className="mech-card" key={id}>
          <div className="row"><b className="grow">{String(c?.name ?? id)}</b>{c?.tag && <span className="chip">{String(c.tag)}</span>}</div>
          {c?.mood && <div className="hint">{String(c.mood)}</div>}
          {typeof c?.affection === "number" && <Bar label="Affection" value={c.affection} color="#ff7aa2" />}
          {typeof c?.trust === "number" && <Bar label="Trust" value={c.trust} color="#7da2ff" />}
          {c?.note && <div className="mech-note">{String(c.note)}</div>}
        </div>
      ))}
    </div>
  );
}

function Status({ data }: { data: any }) {
  const bars: any[] = Array.isArray(data?.bars) ? data.bars : [];
  const tags: any[] = Array.isArray(data?.tags) ? data.tags : [];
  if (!bars.length && !tags.length) return <div className="hint">Once the story starts, the numbers that matter in it show up here.</div>;
  return (
    <>
      {bars.map((b, i) => <Bar key={b.id ?? i} label={String(b.label ?? b.id ?? "")} value={Number(b.value) || 0} max={Number(b.max) || 100} color={/^#[0-9a-f]{6}$/i.test(String(b.color ?? "")) ? b.color : undefined} note={b.note} />)}
      {tags.length > 0 && <div className="chips" style={{ marginTop: 8 }}>{tags.map((t, i) => <span className="chip" key={i}><small>{String(t.label ?? "")}</small> {String(t.value ?? "")}</span>)}</div>}
    </>
  );
}

function VarRow({ v, value, onSet }: { v: MechanicPack["variables"][number]; value: any; onSet: (x: unknown) => void }) {
  if (v.kind === "number" && typeof value === "number") {
    return (
      <div>
        <Bar label={v.name} value={value} min={v.min ?? 0} max={v.max ?? 100} />
        <input type="range" min={v.min ?? 0} max={v.max ?? 100} value={value} aria-label={`Set ${v.name}`} onChange={(e) => onSet(Number(e.target.value))} style={{ width: "100%" }} />
      </div>
    );
  }
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return (
    <div className="mech-var"><b>{v.name}</b><pre>{text.length > 700 ? text.slice(0, 700) + "…" : text}</pre></div>
  );
}

function State({ pack, cm, chatId, onChange }: { pack: MechanicPack; cm: ChatMechanic; chatId: number; onChange: (l: ChatMechanic[]) => void }) {
  const toast = useToast();
  const set = (path: string, value: unknown) => api.setChatVariable(chatId, pack.id, path, value).then(onChange).catch((e) => toast(errText(e), "err"));
  const only = pack.variables.filter((v) => !v.id.startsWith("_"));
  return (
    <div className="mech-state">
      {pack.app === "relations" ? <Relations data={cm.state.app_relations} />
        : pack.app === "status" ? <Status data={cm.state.app_status} />
        : only.map((v) => <VarRow key={v.id} v={v} value={cm.state[v.id]} onSet={(x) => set(v.id, x)} />)}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={() => { if (window.confirm(`Start "${pack.name}" over in this chat? Its numbers go back to the beginning.`)) api.resetChatMechanic(chatId, pack.id).then(onChange); }}>↺ Start over</button>
      </div>
    </div>
  );
}

/** Mechanic packs for one chat: switch them on and off, watch what they track, bring more in. */
export default function MechanicsPanel({ chatId, onClose }: { chatId: number; onClose: () => void }) {
  const toast = useToast();
  const [packs, setPacks] = useState<MechanicPack[] | null>(null);
  const [mine, setMine] = useState<ChatMechanic[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try { const [p, m] = await Promise.all([api.listMechanics(), api.chatMechanics(chatId)]); setPacks(p); setMine(m); } catch (e) { toast(errText(e), "err"); }
  }, [chatId, toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const u = onMechanics((e) => { if (e.chat_id === chatId) void load(); }); return () => { void u.then((f) => f()); }; }, [chatId, load]);

  const toggle = async (p: MechanicPack, on: boolean) => {
    try { setMine(await api.setChatMechanic(chatId, p.id, on)); if (on) setOpen(p.id); } catch (e) { toast(errText(e), "err"); }
  };
  const importFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      try { const p = await api.importMechanic(f); toast(`Added “${p.name}”. Switch it on for this chat when you want it.`, "ok"); } catch (e) { toast(`${f.name}: ${errText(e)}`, "err"); }
    }
    await load();
  };
  const remove = async (p: MechanicPack) => {
    if (!window.confirm(`Remove “${p.name}” from your library? Chats that used it lose its progress.`)) return;
    try { await api.deleteMechanic(p.id); await load(); } catch (e) { toast(errText(e), "err"); }
  };

  return (
    <Modal title="Mechanics" onClose={onClose} wide>
      <p className="sub" style={{ marginBottom: 12 }}>Optional story layers for <b>this chat</b>. Switch on what you want and leave the rest off — you can change your mind any time.</p>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn primary sm" onClick={() => fileRef.current?.click()}>＋ Add a pack (.bundle.json)</button>
        <input ref={fileRef} type="file" hidden multiple accept=".json,application/json" aria-label="Add mechanic packs" onChange={(e) => { void importFiles(e.target.files); e.target.value = ""; }} />
      </div>
      {packs == null ? <div className="hint">Loading…</div> : packs.length === 0 ? (
        <div className="empty-state"><h3>No packs yet</h3><p className="sub">Add a mechanic pack file, like an affection tracker, a status panel or a phone.</p></div>
      ) : (
        <div className="mech-list">
          {packs.map((p) => {
            const cm = mine.find((m) => m.mech_id === p.id);
            const on = !!cm?.enabled;
            return (
              <div className={`mech-pack ${on ? "on" : ""}`} key={p.id} data-pack={p.name}>
                <div className="row">
                  <label className="switch" title={on ? "Switch off for this chat" : "Switch on for this chat"}>
                    <input type="checkbox" role="switch" aria-label={`${p.name} on`} checked={on} onChange={(e) => void toggle(p, e.target.checked)} /><i />
                  </label>
                  <div className="grow">
                    <b>{p.name}</b>
                    <div className="hint">{p.variables.length} variable{p.variables.length === 1 ? "" : "s"} · {p.entries} note{p.entries === 1 ? "" : "s"} · {p.reactions} reaction{p.reactions === 1 ? "" : "s"}</div>
                  </div>
                  {cm && <button className="btn ghost sm" onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>{open === p.id ? "Hide" : "Show"}</button>}
                  <button className="btn ghost sm" onClick={() => void remove(p)} aria-label={`Remove ${p.name}`} title="Remove from library">🗑</button>
                </div>
                {p.description && <p className="hint mech-desc">{p.description.split("\n")[0]}</p>}
                {p.has_ui && p.app === "vars" && <div className="hint">Shown as plain values here (the pack's own screens aren't run).</div>}
                {cm && open === p.id && <State pack={p} cm={cm} chatId={chatId} onChange={setMine} />}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
