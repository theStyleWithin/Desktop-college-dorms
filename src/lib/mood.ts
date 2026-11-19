import type { Character, GalleryItem } from "../api";

/** The moods a gallery picture can show, and the mood detector can pick (the same list as the app's backend). */
export const MOODS: { id: string; label: string; emoji: string }[] = [
  { id: "neutral", label: "Calm / neutral", emoji: "😐" },
  { id: "happy", label: "Happy", emoji: "😊" },
  { id: "laughing", label: "Laughing", emoji: "😂" },
  { id: "loving", label: "Loving / affectionate", emoji: "🥰" },
  { id: "embarrassed", label: "Embarrassed / blushing", emoji: "😳" },
  { id: "smug", label: "Smug / playful", emoji: "😏" },
  { id: "surprised", label: "Surprised", emoji: "😲" },
  { id: "scared", label: "Scared / nervous", emoji: "😨" },
  { id: "sad", label: "Sad", emoji: "😢" },
  { id: "angry", label: "Angry", emoji: "😠" },
  { id: "thinking", label: "Thinking", emoji: "🤔" },
  { id: "sleepy", label: "Sleepy", emoji: "😴" },
];

// words, actions and emoji that point to each mood (a tie goes to the earlier one in this list)
const LEX: [string, RegExp][] = [
  ["embarrassed", /\b(blush(es|ed|ing)?|flustered|embarrass(ed|ing|ment)?|stammer(s|ed|ing)?|bashful|shy(ly)?|cheeks (burn|redden|flush|heat)\w*|fidget(s|ed|ing)?|averts? (her|his|their) (gaze|eyes))\b|😳|\b([a-z])-\1[a-z]*/gi],
  ["laughing", /\b(laugh(s|ed|ing|ter)?|giggl(e|es|ed|ing)|chuckl(e|es|ed|ing)|snicker(s|ed|ing)?|cackl(e|es|ed|ing)|ha(ha)+|he(he)+|lol|burst(s)? (out )?laughing)\b|😂|🤣/gi],
  ["loving", /\b(love|loves|loved|adore(s|d)?|affection(ate)?(ly)?|cuddl(e|es|ed|ing)|hug(s|ged|ging)?|kiss(es|ed|ing)?|darling|sweetheart|cherish(es|ed)?|snuggl(e|es|ed|ing)|nuzzl(e|es|ed|ing)|tender(ly)?|my dear|dearest)\b|❤|💕|😘|🥰|💖/gi],
  ["surprised", /\b(gasp(s|ed)?|surpris(e|ed|ing)|shock(ed)?|startl(e|es|ed)|stunned|wide[- ]eyed|eyes (go |grow |widen)\w*|wow|whoa|no way|what\?!|really\?!)\b|!\?|\?!|😲|😮|😯/gi],
  ["scared", /\b(scared|afraid|fear(ful)?|terrified|trembl(e|es|ed|ing)|shiver(s|ed|ing)?|frighten(ed)?|panic(s|ked|king)?|nervous(ly)?|flinch(es|ed)?|cower(s|ed|ing)?|petrified)\b|😨|😱|😰/gi],
  ["angry", /\b(angry|anger|furious|glare(s|d)?|glaring|scowl(s|ed|ing)?|growl(s|ed|ing)?|snarl(s|ed|ing)?|rage|annoyed|irritated|clench(es|ed)|slams?|fum(e|es|ing)|hmph|how dare you)\b|😠|😡|🤬/gi],
  ["sad", /\b(sad(ly)?|cry|cries|cried|crying|tears?|sob(s|bed|bing)?|sigh(s|ed|ing)?|heartbroken|lonely|sorrow(ful)?|miss you|whimper(s|ed|ing)?|downcast|frown(s|ed|ing)?|gloomy|melanchol\w+)\b|😢|😭|☹|🥺/gi],
  ["smug", /\b(smirk(s|ed|ing)?|smug(ly)?|teas(e|es|ed|ing)|playful(ly)?|wink(s|ed|ing)?|cocky|mischievous(ly)?|sly(ly)?|raises? an eyebrow|arches? an eyebrow|cheeky|flirt(s|ed|ing|atious)?)\b|😏|😉|😜/gi],
  ["happy", /\b(smil(e|es|ed|ing)|grin(s|ned|ning)?|happy|happily|glad|delight(ed|ful)?|cheer(ful|fully|s|ed)?|beam(s|ed|ing)?|excited(ly)?|yay|wonderful|lovely|joy(ful|fully)?|pleased|brightens|giddy|thrilled)\b|😊|😄|🙂|😁|☺|😀/gi],
  ["thinking", /\b(think(s|ing)?|ponder(s|ed|ing)?|hm+|wonder(s|ed|ing)?|consider(s|ed|ing)?|tilts? (her|his|their) head|taps? (her|his|their) chin|muses?|curious(ly)?|puzzled|furrows?)\b|🤔/gi],
  ["sleepy", /\b(yawn(s|ed|ing)?|sleepy|tired|drowsy|exhausted|nap|rubs? (her|his|their) eyes|z{3,}|dozes?|drifts? off)\b|😴|😪/gi],
];

/** How strongly the text points to each mood: a hit in an action (between asterisks) counts double, the end of the message a little more. */
export function moodScores(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  const clean = text.replace(/\[[A-Za-z0-9_.-]+:[^\]]*\]/g, ""); // hidden variable lines are not part of the story
  const actions: [number, number][] = [];
  for (const m of clean.matchAll(/\*[^*\n]+\*/g)) actions.push([m.index!, m.index! + m[0].length]);
  const inAction = (i: number) => actions.some(([a, b]) => i >= a && i < b);
  for (const [mood, re] of LEX) {
    let s = 0;
    for (const m of clean.matchAll(re)) {
      const i = m.index ?? 0;
      s += (inAction(i) ? 2 : 1) * (i > clean.length * 0.6 ? 1.3 : 1);
    }
    if (s) out[mood] = s;
  }
  return out;
}

/** The mood of a reply (`neutral` when nothing in it clearly points to one). */
export function detectMood(text: string): string {
  const sc = moodScores(text);
  let best = "neutral", top = 0;
  for (const [mood] of LEX) if ((sc[mood] ?? 0) > top) { top = sc[mood]; best = mood; }
  return top >= 1.5 ? best : "neutral";
}

const pickOne = <T,>(xs: T[], rnd: () => number) => xs[Math.floor(rnd() * xs.length)];

/**
 * Which gallery picture to show after a reply: `null` means the character's main picture.
 * `random`: any picture but the one shown now. `mood`: one tagged with the reply's mood; if there is none, one tagged
 * neutral, then one with no mood at all, then the main picture. `fixed` (or an empty gallery): the main picture.
 */
export function pickGalleryItem(c: Pick<Character, "gallery" | "gallery_mode">, mood: string, current: string | null, rnd: () => number = Math.random): string | null {
  const items: GalleryItem[] = c.gallery ?? [];
  const mode = c.gallery_mode || "fixed";
  if (!items.length || mode === "fixed") return null;
  const choose = (xs: GalleryItem[]) => { const others = xs.filter((x) => x.id !== current); return pickOne(others.length ? others : xs, rnd).id; };
  if (mode === "random") return choose(items);
  const tagged = items.filter((i) => i.moods.includes(mood));
  if (tagged.length) return choose(tagged);
  const neutral = items.filter((i) => i.moods.includes("neutral"));
  if (neutral.length) return choose(neutral);
  const untagged = items.filter((i) => i.moods.length === 0);
  if (untagged.length) return choose(untagged);
  return null;
}
