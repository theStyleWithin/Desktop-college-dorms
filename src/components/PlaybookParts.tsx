import { type ReactNode } from "react";
import type { PbAct, PbCond, PbVar } from "../api";

/** An input for the value of a variable: a number, yes/no, one of the choices, or text. */
export function ValueInput({ v, value, onChange, label }: { v: PbVar | undefined; value: unknown; onChange: (x: unknown) => void; label: string }) {
  if (!v) return <input type="text" aria-label={label} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
  if (v.kind === "number") return <input type="number" aria-label={label} value={Number(value ?? 0)} min={v.min ?? undefined} max={v.max ?? undefined} onChange={(e) => onChange(Number(e.target.value))} />;
  if (v.kind === "bool") return <select aria-label={label} value={value ? "yes" : "no"} onChange={(e) => onChange(e.target.value === "yes")}><option value="yes">yes</option><option value="no">no</option></select>;
  if (v.kind === "choice") return <select aria-label={label} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>{!v.options.includes(String(value ?? "")) && <option value="">—</option>}{v.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>;
  return <input type="text" aria-label={label} value={String(value ?? "")} maxLength={80} onChange={(e) => onChange(e.target.value)} />;
}

const OPS: [string, string][] = [["==", "is"], ["!=", "is not"], [">", "is more than"], [">=", "is at least"], ["<", "is less than"], ["<=", "is at most"], ["contains", "contains"]];
const KINDS: [PbCond["type"], string][] = [["var", "a value"], ["user_says", "I say"], ["reply_says", "she says"], ["every_n", "every few turns"], ["chance", "a chance"]];

const blankCond = (type: PbCond["type"], vars: PbVar[]): PbCond => {
  switch (type) {
    case "user_says": return { type, words: [] };
    case "reply_says": return { type, words: [] };
    case "every_n": return { type, n: 3 };
    case "chance": return { type, percent: 25 };
    default: return { type: "var", var: vars[0]?.id ?? "", op: ">=", value: vars[0]?.kind === "bool" ? true : vars[0]?.kind === "number" ? 1 : "" };
  }
};

/** A list of conditions, each one a row. `after` allows checks of the reply that was just written. */
export function CondList({ conds, vars, onChange, after, label }: { conds: PbCond[]; vars: PbVar[]; onChange: (c: PbCond[]) => void; after: boolean; label: string }) {
  const set = (i: number, c: PbCond) => onChange(conds.map((x, j) => (j === i ? c : x)));
  return (
    <div className="pb-list" role="group" aria-label={label}>
      {conds.map((c, i) => (
        <div className="pb-row" key={i}>
          <select aria-label="Kind of check" value={c.type} onChange={(e) => set(i, blankCond(e.target.value as PbCond["type"], vars))}>
            {KINDS.filter(([k]) => after || k !== "reply_says").map(([k, n]) => <option key={k} value={k}>{n}</option>)}
          </select>
          {c.type === "var" && <>
            <select aria-label="Value to check" value={c.var} onChange={(e) => set(i, { ...c, var: e.target.value })}>{vars.map((v) => <option key={v.id} value={v.id}>{v.label || v.id}</option>)}</select>
            <select aria-label="Comparison" value={c.op} onChange={(e) => set(i, { ...c, op: e.target.value })}>{OPS.map(([o, n]) => <option key={o} value={o}>{n}</option>)}</select>
            <ValueInput v={vars.find((v) => v.id === c.var)} value={c.value} onChange={(x) => set(i, { ...c, value: x })} label="Compared with" />
          </>}
          {(c.type === "user_says" || c.type === "reply_says") && <input type="text" aria-label="Words or phrases" placeholder="words or phrases, separated by commas" value={c.words.join(", ")} onChange={(e) => set(i, { ...c, words: e.target.value.split(",").map((w) => w.trimStart()) })} />}
          {c.type === "every_n" && <><span>every</span><input type="number" aria-label="Every how many turns" min={1} max={1000} value={c.n} onChange={(e) => set(i, { ...c, n: Number(e.target.value) })} /><span>turns</span></>}
          {c.type === "chance" && <><input type="number" aria-label="Chance in percent" min={0} max={100} value={c.percent} onChange={(e) => set(i, { ...c, percent: Number(e.target.value) })} /><span>% each turn</span></>}
          <button type="button" className="btn sm danger" aria-label="Remove this check" onClick={() => onChange(conds.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button type="button" className="btn sm" onClick={() => onChange([...conds, blankCond(vars.length ? "var" : "user_says", vars)])}>＋ Add a check</button>
    </div>
  );
}

const ACT_OPS = (k: PbVar["kind"] | undefined): [string, string][] =>
  k === "number" ? [["add", "add"], ["subtract", "subtract"], ["set", "set to"], ["clear", "reset"]]
    : k === "bool" ? [["set", "set to"], ["toggle", "flip"], ["clear", "reset"]]
    : k === "text" ? [["set", "set to"], ["append", "add to the end"], ["clear", "reset"]]
    : [["set", "set to"], ["clear", "reset"]];

/** A list of changes ("then do this"). */
export function ActList({ acts, vars, onChange }: { acts: PbAct[]; vars: PbVar[]; onChange: (a: PbAct[]) => void }) {
  const set = (i: number, a: PbAct) => onChange(acts.map((x, j) => (j === i ? a : x)));
  return (
    <div className="pb-list" role="group" aria-label="Then">
      {acts.map((a, i) => {
        const v = vars.find((x) => x.id === a.var);
        const needsValue = a.op !== "toggle" && a.op !== "clear";
        return (
          <div className="pb-row" key={i}>
            <select aria-label="Value to change" value={a.var} onChange={(e) => set(i, { var: e.target.value, op: "set", value: undefined })}>{vars.map((x) => <option key={x.id} value={x.id}>{x.label || x.id}</option>)}</select>
            <select aria-label="Change" value={a.op} onChange={(e) => set(i, { ...a, op: e.target.value })}>{ACT_OPS(v?.kind).map(([o, n]) => <option key={o} value={o}>{n}</option>)}</select>
            {needsValue && <ValueInput v={v} value={a.value ?? (v?.kind === "number" ? 1 : v?.kind === "bool" ? true : "")} onChange={(x) => set(i, { ...a, value: x })} label="By" />}
            <button type="button" className="btn sm danger" aria-label="Remove this change" onClick={() => onChange(acts.filter((_, j) => j !== i))}>×</button>
          </div>
        );
      })}
      <button type="button" className="btn sm" disabled={!vars.length} onClick={() => onChange([...acts, { var: vars[0].id, op: vars[0].kind === "number" ? "add" : "set", value: vars[0].kind === "bool" ? true : vars[0].kind === "number" ? 1 : "" }])}>＋ Add a change</button>
    </div>
  );
}

/** A titled, collapsible block. */
export function Section({ title, hint, children, count }: { title: string; hint?: string; children: ReactNode; count?: string }) {
  return (
    <section className="pb-section">
      <h3>{title}{count ? <small className="tok">{count}</small> : null}</h3>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  );
}
