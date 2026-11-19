import { detectMood, pickGalleryItem } from "./mood.mjs";
const cases = [
  ["*laughs and wipes a tear* Haha, you're ridiculous!", "laughing"],
  ["*blushes and looks away* I-It's not like I wanted you to stay or anything...", "embarrassed"],
  ["*smiles warmly* I'm so glad you came by. Come, sit with me.", "happy"],
  ["*her eyes widen and she gasps* What?! You did that?!", "surprised"],
  ["*glares at you, fists clenched* How dare you speak to me like that.", "angry"],
  ["*sniffles, tears running down her cheeks* I just miss them so much.", "sad"],
  ["*trembles and hides behind you* S-something is out there...", "scared"],
  ["*smirks and raises an eyebrow* Oh? Is that a challenge?", "smug"],
  ["*yawns and rubs her eyes* It's so late, I could fall asleep right here.", "sleepy"],
  ["*taps her chin* Hmm... let me think about that for a moment.", "thinking"],
  ["*hugs you tightly* I love you so much, darling.", "loving"],
  ["The weather is mild today and the store opens at nine.", "neutral"],
  ["Sure. Here's the list you asked for.", "neutral"],
  ["The x-ray machine is in room four.", "neutral"],
];
let bad = 0;
for (const [t, want] of cases) { const got = detectMood(t); if (got !== want) { bad++; console.log("MISS", want, "got", got, "|", t); } }
console.log(bad ? `${bad} wrong` : "all mood cases right");
const g = (id, moods) => ({ id, file: id, kind: "image", moods });
const c = { gallery: [g("a", ["happy"]), g("b", ["happy"]), g("c", ["sad"]), g("d", []), g("e", ["neutral"])], gallery_mode: "mood" };
const fixed = () => 0;
console.log("mood happy ->", pickGalleryItem(c, "happy", null, fixed), "(a)");
console.log("mood happy, now a ->", pickGalleryItem(c, "happy", "a", fixed), "(b)");
console.log("mood angry, none tagged -> neutral:", pickGalleryItem(c, "angry", null, fixed), "(e)");
console.log("no neutral -> untagged:", pickGalleryItem({ ...c, gallery: [g("a", ["happy"]), g("d", [])] }, "angry", null, fixed), "(d)");
console.log("nothing fits -> main:", pickGalleryItem({ ...c, gallery: [g("a", ["happy"])] }, "angry", null, fixed), "(null)");
console.log("fixed ->", pickGalleryItem({ ...c, gallery_mode: "fixed" }, "happy", null, fixed), "(null)");
console.log("random avoids the current one:", pickGalleryItem({ ...c, gallery_mode: "random" }, "x", "a", fixed), "(b)");
