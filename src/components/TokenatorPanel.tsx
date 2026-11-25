import { useMemo, useState } from "react";
import { api, type CardData } from "../api";
import { Modal, useToast } from "./ui";
import { BUDGETS, FIELDS, budgetTokens, counts, modelName, repeated, shareOf, suggestBudget, totalTokens } from "../lib/tokenator";
import { errText, tokens } from "../lib/util";
import { useStore } from "../store";

type Result = { field: string; before: string; after: string; mode: "trim" | "draft" };

/** Counts tokens per card field against a budget, shortens a field or drafts one with the person's own model. Nothing changes until it is accepted. */
export default function TokenatorPanel({ card, onApply, onClose }: { card: CardData; onApply: (field: string, text: string) => void; onClose: () => void }) {
  const { settings } = useStore();
  const toast = useToast();
  const model = modelName(settings);
  const [budget, setBudget] = useState(() => suggestBudget(settings.context_tokens));
  const [busy, setBusy] = useState<string | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [dField, setDField] = useState("description");
  const [notes, setNotes] = useState("");
  const cap = budgetTokens(budget);
  const rows = counts(card);
  const total = totalTokens(card);
  const dupes = useMemo(() => repeated(card), [card]);
  const val = (k: string) => String((card as any)[k] ?? "");
  const context = () => FIELDS.map((f) => val(f.key).trim() && `${f.label}: ${val(f.key)}`).filter(Boolean).join("\n").slice(0, 3000);

  const run = async (mode: "trim" | "draft", field: string) => {
    setBusy(field); setRes(null);
    try {
      const target = mode === "trim" ? (cap ? shareOf(card, field, cap) : Math.max(60, Math.floor(tokens(val(field)) * 0.7))) : (cap ? Math.max(60, Math.floor(cap / 4)) : 400);
      const after = await api.tokenatorRun(mode, field, val(field), notes, context(), target);
      setRes({ field, before: val(field), after, mode });
    } catch (e) { toast(errText(e), "err"); } finally { setBusy(null); }
  };
  const label = (k: string) => FIELDS.find((f) => f.key === k)?.label ?? k;
  const accept = (add: boolean) => {
    if (!res) return;
    const cur = val(res.field);
    onApply(res.field, add && cur.trim() ? `${cur.trimEnd()}\n\n${res.after}` : res.after);
    setRes(null); toast("Applied. Save the card to keep it.");
  };

  return (
    <Modal title="✂️ Tokenator" onClose={onClose} wide>
      <div data-testid="tokenator">
        <p className="sub">Counts are estimates (about 4 characters a token). Nothing changes on the card until you accept it.</p>
        <label className="field"><span>Budget for the whole card</span>
          <select value={budget} onChange={(e) => setBudget(e.target.value)} aria-label="Budget" data-testid="tok-budget">
            {BUDGETS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select></label>
        <p className="tok" data-testid="tok-total">Total: {total} token(s){cap ? ` of ${cap}${total > cap ? ` — ${total - cap} over` : ""}` : ""}. Your context window is {settings.context_tokens}.</p>
        <div style={{ display: "grid", gap: 8, margin: "8px 0" }}>
          {rows.map((r) => {
            const share = cap && r.tokens ? Math.max(1, Math.round((r.tokens / cap) * 100)) : 0;
            return (
              <div key={r.key} data-testid={`tok-row-${r.key}`}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="grow">{r.label} <span className="tok">{r.tokens} token(s)</span></span>
                  <button type="button" className="btn sm" disabled={!model || !r.tokens || busy !== null} onClick={() => run("trim", r.key)} data-testid={`tok-trim-${r.key}`}>
                    {busy === r.key ? "Working…" : "Make shorter"}
                  </button>
                </div>
                {cap > 0 && <div className="bar" aria-hidden><div style={{ width: `${Math.min(100, share)}%`, background: share > 100 ? "var(--danger, #c44)" : undefined }} /></div>}
              </div>
            );
          })}
        </div>
        {dupes.length > 0 && (
          <div className="hint" data-testid="tok-repeats" style={{ margin: "8px 0" }}>
            <b>Said more than once:</b>
            <ul style={{ margin: "4px 0 0 18px" }}>
              {dupes.slice(0, 5).map((d, i) => <li key={i}>“{d.sentence.length > 90 ? d.sentence.slice(0, 90) + "…" : d.sentence}” <span className="tok">({d.where.join(", ")})</span></li>)}
            </ul>
          </div>
        )}
        <p className="tok" data-testid="tok-model">
          {model ? `Using ${model} (the one you set up in Settings).` : "No model is set up, so counting works but the writing helpers are off. Set one up in Settings to use them."}
        </p>
        {res && (
          <div className="card" data-testid="tok-result" style={{ margin: "10px 0" }}>
            <b>{res.mode === "trim" ? `Shorter ${label(res.field)}` : `Drafted ${label(res.field)}`}</b>
            <div className="tok">{res.mode === "trim" ? `${tokens(res.before)} → ${tokens(res.after)} token(s)` : `${tokens(res.after)} token(s)`}</div>
            {res.mode === "trim" && <><div className="hint">Before</div><pre style={{ whiteSpace: "pre-wrap", margin: 0 }} data-testid="tok-before">{res.before}</pre></>}
            <div className="hint">{res.mode === "trim" ? "After" : "Draft"}</div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }} data-testid="tok-after">{res.after}</pre>
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button type="button" className="btn primary sm" onClick={() => accept(false)} data-testid="tok-accept">Accept</button>
              {res.mode === "draft" && val(res.field).trim() && <button type="button" className="btn sm" onClick={() => accept(true)} data-testid="tok-add">Add to end</button>}
              <button type="button" className="btn sm" onClick={() => run(res.mode, res.field)} disabled={busy !== null} data-testid="tok-retry">Try again</button>
              <button type="button" className="btn ghost sm" onClick={() => setRes(null)} data-testid="tok-discard">Discard</button>
            </div>
          </div>
        )}
        <h3 style={{ marginTop: 14 }}>Help me write</h3>
        <div className="pb-row">
          <label className="field"><span>Field</span>
            <select value={dField} onChange={(e) => setDField(e.target.value)} aria-label="Field to write" data-testid="tok-dfield">
              {FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select></label>
          <label className="field grow"><span>Rough notes</span>
            <textarea rows={3} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. shy library student, loves tea, secretly writes poems" data-testid="tok-notes" /></label>
        </div>
        <button type="button" className="btn" disabled={!model || !notes.trim() || busy !== null} onClick={() => run("draft", dField)} data-testid="tok-draft">{busy === dField && !res ? "Working…" : "Write a draft"}</button>
      </div>
    </Modal>
  );
}
