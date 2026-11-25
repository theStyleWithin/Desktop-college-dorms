import type { CardData, Settings } from "../api";
import { tokens } from "./util";

/** The card fields Tokenator looks at, in the order they are shown. */
export const FIELDS: { key: string; label: string }[] = [
  { key: "description", label: "Description" },
  { key: "personality", label: "Personality" },
  { key: "scenario", label: "Scenario" },
  { key: "first_mes", label: "First message" },
  { key: "mes_example", label: "Example dialogue" },
  { key: "system_prompt", label: "System prompt" },
  { key: "post_history_instructions", label: "Post-history instructions" },
];

export const BUDGETS: { id: string; label: string; tokens: number }[] = [
  { id: "tiny", label: "Tiny (400)", tokens: 400 },
  { id: "small", label: "Small (800)", tokens: 800 },
  { id: "normal", label: "Normal (1500)", tokens: 1500 },
  { id: "large", label: "Large (3000)", tokens: 3000 },
  { id: "none", label: "No budget", tokens: 0 },
];

/** A budget that leaves most of the context window for the chat itself (about a fifth, rounded down to a preset). */
export function suggestBudget(contextTokens: number): string {
  const share = contextTokens / 5;
  const fit = [...BUDGETS].filter((b) => b.tokens > 0 && b.tokens <= share).pop();
  return (fit ?? BUDGETS[0]).id;
}

export const budgetTokens = (id: string) => BUDGETS.find((b) => b.id === id)?.tokens ?? 0;

const text = (card: CardData, key: string) => String((card as any)[key] ?? "");

/** Token estimate for each field (an estimate: about 4 characters a token). */
export const counts = (card: CardData) => FIELDS.map((f) => ({ ...f, tokens: tokens(text(card, f.key)) }));

/** Total of every field, and of the ones sent with every message. */
export const totalTokens = (card: CardData) => counts(card).reduce((n, f) => n + f.tokens, 0);

/** How much each field may use if the budget is shared by what each uses now (never below 60). */
export function shareOf(card: CardData, key: string, budget: number): number {
  const total = totalTokens(card);
  if (!budget || !total) return 0;
  const mine = tokens(text(card, key));
  return Math.max(60, Math.min(mine, Math.floor((mine / total) * budget)));
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();
const sentences = (s: string) => s.split(/(?<=[.!?\n])\s+/).map((x) => x.trim()).filter((x) => norm(x).length >= 25);

/** Sentences that appear more than once, in one field or across fields. */
export function repeated(card: CardData): { sentence: string; where: string[] }[] {
  const seen = new Map<string, { sentence: string; where: string[] }>();
  for (const f of FIELDS) {
    for (const s of sentences(text(card, f.key))) {
      const k = norm(s);
      const e = seen.get(k);
      if (e) e.where.push(f.label); else seen.set(k, { sentence: s, where: [f.label] });
    }
  }
  return [...seen.values()].filter((e) => e.where.length > 1);
}

/** Whether a model looks set up (the real answer comes from asking it; this is only so the AI buttons can say so up front). */
export function modelName(s: Settings): string | null {
  switch (s.provider) {
    case "local": return s.local_model ? "the built-in model" : null;
    case "openai": return s.openai_model || s.openai_base_url ? `the cloud model ${s.openai_model || ""}`.trim() : null;
    case "anthropic": return s.anthropic_model ? `the cloud model ${s.anthropic_model}` : null;
    default: return s.provider.startsWith("custom:") ? "your Other API model" : null;
  }
}
