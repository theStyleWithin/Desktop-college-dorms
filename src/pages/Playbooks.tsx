import { useEffect, useState } from "react";
import { api, blankPlaybook, type Lorebook, type PbBand, type PbRule, type PbVar, type Playbook } from "../api";
import { ActList, CondList, Section, ValueInput } from "../components/PlaybookParts";
import ShelfView, { NewFolderButton, useShelf } from "../components/Shelf";
import TokenatorHelper from "../components/TokenatorHelper";
import { useToast } from "../components/ui";
import { errText } from "../lib/util";
import { useStore } from "../store";

const slug = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "").replace(/^_+|_+$/g, "").slice(0, 24);
const blankVar = (n: number): PbVar => ({ id: `value_${n}`, label: "", kind: "number", default: 0, min: 0, max: 10, options: [], note: "", bands: [] });
const blankRule = (n: number): PbRule => ({ id: `rule_${n}`, name: "", phase: "before", when: [], when_any: [], ask: "", fallback: [], then: [] });

/** Playbooks: a story's state (values), and rules that change it before and after each reply. */
export default function Playbooks({ edit }: { edit?: string | "new" }) {
  const { go } = useStore();
  const toast = useToast();
  const [list, setList] = useState<Playbook[] | null>(null);
  const [starters, setStarters] = useState<Playbook[]>([]);
  const shelf = useShelf("playbooks");
  const load = async () => { try { setList(await api.listPlaybooks()); setStarters(await api.playbookTemplates()); } catch (e) { toast(errText(e), "err"); } };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, []);
  if (edit) return <Editor id={edit} starters={starters} onDone={() => go({ page: "playbooks" })} />;
  if (!list) return <div className="page sub">Loading…</div>;
  const open = (id: string) => go({ page: "playbooks", edit: id });
  const copy = async (p: Playbook) => { try { const n = await api.savePlaybook({ ...p, id: "", name: `${p.name} copy`.slice(0, 60) }); await load(); open(n.id); } catch (e) { toast(errText(e), "err"); } };
  const fromStarter = async (p: Playbook) => { try { const n = await api.savePlaybook({ ...p, id: "" }); await load(); open(n.id); } catch (e) { toast(errText(e), "err"); } };
  return (
    <div className="pb-page" data-testid="playbooks-page">
      <h2>🎲 Playbooks</h2>
      <p className="sub">A playbook keeps track of a story: values like trust, hunger or the weather, and rules that change them before and after every reply. The characters are told the values and what they mean, so they act on them. One playbook runs in a chat at a time, from a character or chosen for that chat.</p>
      <div className="row"><button className="btn primary" onClick={() => open("new")} data-testid="pb-new">＋ New playbook</button>
        <NewFolderButton api={shelf} /></div>
      <div>
        <ShelfView kind="playbooks" api={shelf} layout="grid" items={list} renderItem={(p) => (
          <div className="pb-tile" data-pb={p.id}>
            <button type="button" className="btn ghost" style={{ textAlign: "left", padding: 0 }} onClick={() => open(p.id)}><b>{p.name}</b></button>
            <span className="hint">{p.description || "No description."}</span>
            <span className="tok">{p.variables.length} values · {p.rules.length} rules</span>
            <span className="row"><button className="btn sm" onClick={() => open(p.id)}>Edit</button><button className="btn sm" onClick={() => void copy(p)}>Duplicate</button></span>
          </div>
        )} />
        {!list.length && <div className="hint">No playbooks yet. Start from one below, or make your own.</div>}
      </div>
      <h3>Starters</h3>
      <p className="sub">Ready-made ones to play, or to change into your own. Starting one makes your own copy.</p>
      <div className="pb-grid">
        {starters.map((p) => (
          <div className="pb-tile" key={p.name} data-starter={p.name}>
            <b>{p.name}</b><span className="hint">{p.description}</span>
            <span className="tok">{p.variables.length} values · {p.rules.length} rules</span>
            <span><button className="btn sm" onClick={() => void fromStarter(p)}>Use this</button></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Editor({ id, starters, onDone }: { id: string; starters: Playbook[]; onDone: () => void }) {
  const toast = useToast();
  const [pb, setPb] = useState<Playbook | null>(null);
  const [books, setBooks] = useState<Lorebook[]>([]);
  const [dirty, setDirty] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState("");
  useEffect(() => {
    void (async () => {
      try {
        setBooks(await api.listLorebooks());
        if (id === "new") { setPb(blankPlaybook()); return; }
        setPb((await api.listPlaybooks()).find((p) => p.id === id) ?? null);
      } catch (e) { toast(errText(e), "err"); }
    })();
    // eslint-disable-next-line
  }, [id]);
  void starters;
  if (!pb) return <div className="page sub">Loading…</div>;
  const set = (p: Partial<Playbook>) => { setPb({ ...pb, ...p }); setDirty(true); };
  const vars = pb.variables;
  const setVar = (i: number, p: Partial<PbVar>) => set({ variables: vars.map((v, j) => (j === i ? { ...v, ...p } : v)) });
  const setRule = (i: number, p: Partial<PbRule>) => set({ rules: pb.rules.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const save = async (p: Playbook = pb): Promise<boolean> => {
    try {
      const saved = await api.savePlaybook(p); setPb(saved); setDirty(false); toast("Saved.", "ok");
      if (id === "new") onDone();
      return true;
    } catch (e) { toast(errText(e), "err"); return false; }
  };
  const del = async () => { if (id === "new" || !window.confirm(`Delete “${pb.name}”? Chats using it keep their story but lose the rules.`)) return; try { await api.deletePlaybook(id); onDone(); } catch (e) { toast(errText(e), "err"); } };
  const back = () => { if (!dirty || window.confirm("Leave without saving your changes?")) onDone(); };
  const toggleBook = (bid: string) => set({ lorebooks: pb.lorebooks.includes(bid) ? pb.lorebooks.filter((b) => b !== bid) : [...pb.lorebooks, bid].slice(0, 4) });

  return (
    <div className="pb-page" data-testid="playbook-editor">
      <div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={back}>← Playbooks</button>
        <input type="text" className="note-title grow" aria-label="Playbook name" placeholder="Playbook name" maxLength={60} value={pb.name} onChange={(e) => set({ name: e.target.value })} />
        <button className="btn primary" disabled={!dirty && id !== "new"} onClick={() => void save()} data-testid="pb-save">Save</button>
        {id !== "new" && <button className="btn danger" aria-label="Delete playbook" onClick={() => void del()}>🗑</button>}
      </div>
      <label className="field"><span>What it is</span><input type="text" maxLength={600} value={pb.description} onChange={(e) => set({ description: e.target.value })} placeholder="A short description for the list" /></label>
      <label className="field"><span>Instructions (shown to you in the chat)</span><textarea rows={3} maxLength={2000} value={pb.instructions} onChange={(e) => set({ instructions: e.target.value })} placeholder="How to play it: what the values mean, what to try." /></label>

      <TokenatorHelper<Playbook> kind="playbook" label="Tokenator: help me build this playbook"
        intro="A playbook keeps track of things in your story, like trust or mood, and changes them when certain words are said. The characters are told the current values, so the story can grow. Say what you want to track, in plain words, and Tokenator drafts the values and rules. They are added to what you already have; nothing changes until you accept, and you can edit every part."
        placeholder="e.g. a slow friendship: trust grows when I'm kind and drops when I'm rude, and their mood changes with it"
        context={() => vars.length ? `Values this playbook already has, which must not be repeated: ${vars.map((v) => v.id).join(", ")}.` : ""}
        preview={(r) => (
          <div className="card" style={{ background: "var(--panel2)", display: "grid", gap: 6 }} data-testid="tokenator-playbook-preview">
            <b>{r.name}</b>{r.description && <div>{r.description}</div>}
            <div className="hint">Values</div>
            {r.variables.map((v) => <div key={v.id}>• <b>{v.label || v.id}</b> <span className="tok">{v.kind === "number" ? `number ${v.min}–${v.max}, starts ${String(v.default)}` : v.kind === "choice" ? `one of ${v.options.join(", ")}, starts ${String(v.default)}` : v.kind}</span></div>)}
            <div className="hint">Rules</div>
            {r.rules.map((x) => <div key={x.id}>• <b>{x.name}</b>: when you say {x.when.flatMap((c) => (c.type === "user_says" ? c.words : [])).map((w) => `“${w}”`).join(", ")} → {x.then.map((a) => a.op === "add" ? `${a.var} +${String(a.value)}` : a.op === "subtract" ? `${a.var} −${String(a.value)}` : `${a.var} = ${String(a.value)}`).join(", ")}</div>)}
          </div>
        )}
        onAccept={(r) => {
          const have = new Set(vars.map((v) => v.id));
          const variables = [...vars, ...r.variables.filter((v) => !have.has(v.id))].slice(0, 10);
          const ids = new Set(variables.map((v) => v.id)), used = new Set(pb.rules.map((x) => x.id));
          const rules = r.rules.filter((x) => x.then.every((a) => ids.has(a.var))).map((x) => (used.has(x.id) ? { ...x, id: `${x.id}_${pb.rules.length + 1}` } : x));
          const next = { ...pb, name: pb.name.trim() ? pb.name : r.name, description: pb.description.trim() ? pb.description : r.description, instructions: pb.instructions.trim() ? pb.instructions : r.instructions, variables, rules: [...pb.rules, ...rules].slice(0, 15) };
          set(next);
          return save(next).then((ok) => { if (!ok) throw new Error("The playbook could not be saved, so the draft is still here."); });
        }} />

      <Section title="Values" count={`${vars.length} of 10`} hint="What the story keeps track of. Each value has a name the rules use, and a note the characters read so they know what it means.">
        {vars.map((v, i) => (
          <div className="pb-card" key={i} data-var={v.id}>
            <div className="pb-row">
              <input type="text" aria-label="Value name" placeholder="name, e.g. trust" value={v.id} onChange={(e) => setVar(i, { id: slug(e.target.value) })} />
              <input type="text" aria-label="Label" placeholder="label shown to you" value={v.label} maxLength={40} onChange={(e) => setVar(i, { label: e.target.value })} />
              <select aria-label="Kind" value={v.kind} onChange={(e) => { const kind = e.target.value as PbVar["kind"]; setVar(i, { kind, default: kind === "number" ? 0 : kind === "bool" ? false : kind === "choice" ? (v.options[0] ?? "") : "" }); }}>
                <option value="number">number</option><option value="bool">yes / no</option><option value="text">text</option><option value="choice">one of a list</option>
              </select>
              <button type="button" className="btn sm danger" aria-label="Remove this value" onClick={() => set({ variables: vars.filter((_, j) => j !== i) })}>×</button>
            </div>
            {v.kind === "number" && <div className="pb-row"><span>from</span><input type="number" aria-label="Lowest" value={v.min ?? 0} onChange={(e) => setVar(i, { min: Number(e.target.value) })} /><span>to</span><input type="number" aria-label="Highest" value={v.max ?? 10} onChange={(e) => setVar(i, { max: Number(e.target.value) })} /></div>}
            {v.kind === "choice" && <div className="pb-row"><input type="text" aria-label="Options" placeholder="options, separated by commas" value={v.options.join(", ")} onChange={(e) => setVar(i, { options: e.target.value.split(",").map((o) => o.trimStart()) })} /></div>}
            <div className="pb-row"><span>starts as</span><ValueInput v={{ ...v, options: v.options.map((o) => o.trim()).filter(Boolean) }} value={v.default} onChange={(x) => setVar(i, { default: x })} label="Starts as" /></div>
            <input type="text" aria-label="Note for the characters" placeholder="Told to the characters: what this value is" maxLength={300} value={v.note} onChange={(e) => setVar(i, { note: e.target.value })} />
            {v.kind === "number" && (
              <div>
                <div className="hint">What it means as it grows (told to the characters):</div>
                {v.bands.map((b, k) => (
                  <div className="pb-row" key={k}>
                    <span>from</span><input type="number" aria-label="From" value={b.from} onChange={(e) => setVar(i, { bands: v.bands.map((x, j) => (j === k ? { ...x, from: Number(e.target.value) } : x)) })} />
                    <input type="text" aria-label="Meaning" placeholder="e.g. wary of you" maxLength={120} value={b.text} onChange={(e) => setVar(i, { bands: v.bands.map((x, j) => (j === k ? { ...x, text: e.target.value } : x)) })} />
                    <button type="button" className="btn sm danger" aria-label="Remove this meaning" onClick={() => setVar(i, { bands: v.bands.filter((_, j) => j !== k) })}>×</button>
                  </div>
                ))}
                {v.bands.length < 8 && <button type="button" className="btn sm" onClick={() => setVar(i, { bands: [...v.bands, { from: (v.bands.length ? v.bands[v.bands.length - 1].from : (v.min ?? 0) - 1) + 1, text: "" } as PbBand] })}>＋ Add a meaning</button>}
              </div>
            )}
          </div>
        ))}
        {vars.length < 10 && <button className="btn" onClick={() => set({ variables: [...vars, blankVar(vars.length + 1)] })} data-testid="pb-add-var">＋ Add a value</button>}
      </Section>

      <Section title="Rules" count={`${pb.rules.length} of 15`} hint="When something holds, change values. A rule that runs before the reply shapes it; one that runs after can read what was just written. A rule can also ask the model a question, up to 3 per playbook.">
        {pb.rules.map((r, i) => (
          <div className="pb-card" key={i} data-rule={r.id}>
            <div className="pb-row">
              <input type="text" aria-label="Rule name" placeholder="rule name" maxLength={60} value={r.name} onChange={(e) => setRule(i, { name: e.target.value })} />
              <select aria-label="Runs" value={r.phase} onChange={(e) => setRule(i, { phase: e.target.value as "before" | "after" })}><option value="before">before the reply</option><option value="after">after the reply</option></select>
              <button type="button" className="btn sm danger" aria-label="Remove this rule" onClick={() => set({ rules: pb.rules.filter((_, j) => j !== i) })}>×</button>
            </div>
            <div><b>If all of these hold</b><CondList conds={r.when} vars={vars} after={r.phase === "after"} label="All of" onChange={(c) => setRule(i, { when: c })} /></div>
            <div><b>and at least one of these (optional)</b><CondList conds={r.when_any} vars={vars} after={r.phase === "after"} label="Any of" onChange={(c) => setRule(i, { when_any: c })} /></div>
            <label className="field"><span>and the model says yes to (optional)</span><input type="text" maxLength={400} value={r.ask} onChange={(e) => setRule(i, { ask: e.target.value })} placeholder="e.g. Did the player earn her trust this turn?" /></label>
            {r.ask.trim() && <div><b>When the model is not asked, check this instead</b><CondList conds={r.fallback} vars={vars} after={r.phase === "after"} label="Instead" onChange={(c) => setRule(i, { fallback: c })} /></div>}
            <div><b>Then</b><ActList acts={r.then} vars={vars} onChange={(a) => setRule(i, { then: a })} /></div>
          </div>
        ))}
        {pb.rules.length < 15 && <button className="btn" disabled={!vars.length} onClick={() => set({ rules: [...pb.rules, blankRule(pb.rules.length + 1)] })} data-testid="pb-add-rule">＋ Add a rule</button>}
        {!vars.length && <div className="hint">Add a value first; rules change values.</div>}
      </Section>

      <Section title="Lorebooks" count={`${pb.lorebooks.length} of 4`} hint="Lorebooks that go with this story. Each one can be on from the start, or have entries that only become available when the story reaches a state.">
        {books.map((b) => {
          const on = pb.lorebooks.includes(b.id);
          const cfg = pb.lore.find((g) => g.book === b.id) ?? { book: b.id, default_on: true, gates: [] };
          const setCfg = (p: Partial<typeof cfg>) => set({ lore: [...pb.lore.filter((g) => g.book !== b.id), { ...cfg, ...p }] });
          return (
            <div className="pb-card" key={b.id}>
              <label className="check"><input type="checkbox" checked={on} onChange={() => toggleBook(b.id)} /> <b>📚 {b.name}</b> <span className="tok">{b.book?.entries?.length ?? 0} entries</span></label>
              {on && <>
                <label className="check"><input type="checkbox" checked={cfg.default_on} onChange={(e) => setCfg({ default_on: e.target.checked })} /> Entries are available from the start</label>
                <div className="hint">Entries that wait for the story (name or #number as in the lorebook):</div>
                {cfg.gates.map((g, k) => (
                  <div className="pb-card" key={k}>
                    <div className="pb-row">
                      <input type="text" aria-label="Entry" placeholder="entry name or #3" value={g.entry} onChange={(e) => setCfg({ gates: cfg.gates.map((x, j) => (j === k ? { ...x, entry: e.target.value } : x)) })} />
                      <button type="button" className="btn sm danger" aria-label="Remove this entry rule" onClick={() => setCfg({ gates: cfg.gates.filter((_, j) => j !== k) })}>×</button>
                    </div>
                    <span className="hint">available when all of these hold</span>
                    <CondList conds={g.when} vars={vars} after={false} label="Available when" onChange={(c) => setCfg({ gates: cfg.gates.map((x, j) => (j === k ? { ...x, when: c } : x)) })} />
                  </div>
                ))}
                <button type="button" className="btn sm" onClick={() => setCfg({ gates: [...cfg.gates, { entry: "", when: [] }] })}>＋ Add an entry that waits</button>
              </>}
            </div>
          );
        })}
        {!books.length && <div className="hint">No lorebooks yet. Make some on the Lorebooks page.</div>}
      </Section>

      <Section title="Starting scenarios" count={`${pb.scenarios.length} of 8`} hint='Different places for the story to begin ("Strangers", "Old friends"): each sets the values it cares about.'>
        {pb.scenarios.map((s, i) => (
          <div className="pb-card" key={i} data-scenario={s.name}>
            <div className="pb-row">
              <input type="text" aria-label="Scenario name" placeholder="scenario name" maxLength={40} value={s.name} onChange={(e) => set({ scenarios: pb.scenarios.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              <input type="text" aria-label="Scenario description" placeholder="short description" maxLength={200} value={s.description} onChange={(e) => set({ scenarios: pb.scenarios.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} />
              <button type="button" className="btn sm danger" aria-label="Remove this scenario" onClick={() => set({ scenarios: pb.scenarios.filter((_, j) => j !== i) })}>×</button>
            </div>
            {vars.map((v) => (
              <div className="pb-row" key={v.id}><span style={{ minWidth: 100 }}>{v.label || v.id}</span><ValueInput v={v} value={s.values[v.id] ?? v.default} onChange={(x) => set({ scenarios: pb.scenarios.map((y, j) => (j === i ? { ...y, values: { ...y.values, [v.id]: x } } : y)) })} label={`${v.id} in this scenario`} /></div>
            ))}
          </div>
        ))}
        {pb.scenarios.length < 8 && <button className="btn" onClick={() => set({ scenarios: [...pb.scenarios, { name: "", description: "", values: {} }] })}>＋ Add a scenario</button>}
      </Section>

      <Section title="Advanced" hint="The whole playbook as text (JSON), to copy, share or paste in.">
        <button className="btn sm" onClick={() => { setAdvanced(!advanced); setJson(JSON.stringify({ ...pb, id: undefined, created_at: undefined, updated_at: undefined }, null, 2)); }}>{advanced ? "Hide" : "Show as text"}</button>
        {advanced && <>
          <textarea rows={14} aria-label="Playbook as text" value={json} onChange={(e) => setJson(e.target.value)} style={{ width: "100%", fontFamily: "monospace" }} />
          <button className="btn sm" onClick={() => { try { const p = JSON.parse(json); setPb({ ...blankPlaybook(), ...p, id: pb.id, created_at: pb.created_at, updated_at: pb.updated_at }); setDirty(true); toast("Applied. Save to keep it.", "ok"); } catch { toast("That isn't valid playbook text.", "err"); } }}>Apply</button>
        </>}
      </Section>
    </div>
  );
}
