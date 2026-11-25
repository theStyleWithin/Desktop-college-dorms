import type { Settings } from "../api";

export type Vision = "yes" | "no" | "unknown";

/** Model names that are known to take pictures. A name that matches none of these is "unknown", not "no". */
const SEES = /(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5|chatgpt-4o|(^|[\/\-_:])o[134]($|[\-_:])|vision|llava|bakllava|moondream|minicpm-v|pixtral|gemini|claude|gemma-?3|llama-?3\.2-(11|90)b|llama-?4|qwen[\d.]*-?vl|internvl|grok-(2-vision|4)|mistral-(small-3|medium)|phi-?[34]-?(vision|multimodal)|[\-_]vl([\-_:]|$))/i;

/** Which model is selected, what to call it, and whether it can see pictures as far as the app can tell. */
export function modelInfo(s: Settings): { label: string; vision: Vision } {
  const p = s.provider;
  if (p === "local") return { label: s.local_model ? `the built-in model (${s.local_model})` : "the built-in model", vision: "no" };
  if (p === "anthropic") return { label: s.anthropic_model || "the Anthropic model", vision: "yes" };
  if (p === "openai") { const m = s.openai_model || ""; return { label: m || "the cloud model", vision: SEES.test(m) ? "yes" : "unknown" }; }
  const prof = (s.profiles ?? []).find((x) => `custom:${x.id}` === p);
  if (prof) return { label: prof.model || prof.name, vision: prof.format === "anthropic" || SEES.test(prof.model) ? "yes" : "unknown" };
  return { label: "the selected model", vision: "unknown" };
}

const key = (label: string) => `dorms.tokenator.sees.${label}`;
export const savedSees = (label: string): boolean | null => { try { const v = localStorage.getItem(key(label)); return v === "1" ? true : v === "0" ? false : null; } catch { return null; } };
export const saveSees = (label: string, on: boolean) => { try { localStorage.setItem(key(label), on ? "1" : "0"); } catch { /* storage unavailable */ } };
