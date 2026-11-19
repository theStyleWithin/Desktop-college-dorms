// Dev-only sample data for the preview pages: drawn portraits (the real avatars are the characters' own pictures).
/** a simple drawn portrait, so the round avatars look like pictures (the real ones are the characters' own images) */
export const portrait = (h: number, hair: string, skin: string, kind: number) => {
  const bg = `hsl(${h} 45% 38%)`, bg2 = `hsl(${(h + 50) % 360} 50% 24%)`;
  const hairShape = kind % 3 === 0 ? `<path d="M22 52c0-24 12-34 28-34s28 10 28 34c-6-14-14-20-28-20s-22 6-28 20z" fill="${hair}"/>`
    : kind % 3 === 1 ? `<path d="M20 70c-4-30 6-52 30-52s34 22 30 52c-2-18-8-30-30-30s-28 12-30 30z" fill="${hair}"/>`
    : `<path d="M24 46c2-18 14-26 26-26s24 8 26 26c-8-8-16-10-26-10s-18 2-26 10z" fill="${hair}"/><circle cx="26" cy="30" r="9" fill="${hair}"/><circle cx="74" cy="30" r="9" fill="${hair}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/>${kind % 3 === 1 ? hairShape : ""}<ellipse cx="50" cy="60" rx="22" ry="26" fill="${skin}"/>${kind % 3 !== 1 ? hairShape : ""}<circle cx="41" cy="60" r="2.6" fill="#2b2233"/><circle cx="59" cy="60" r="2.6" fill="#2b2233"/><path d="M43 72q7 6 14 0" stroke="#7a3e48" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M14 100c4-16 18-22 36-22s32 6 36 22z" fill="hsl(${(h + 150) % 360} 35% 45%)"/></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
};
export const P: [string, number, string, string, string | undefined][] = [
  ["Mira Okafor", 330, "#3a2418", "#f1c9a5", "brewing tea and pretending not to wait for your message ☕"],
  ["Kai Tanaka", 200, "#1d1d2b", "#e9bf9d", "arguing with the vending machine. again."],
  ["Seraphina Vale", 275, "#d8c8f0", "#f7d9c4", "reading by candlelight. do not disturb (but do)"],
  ["Dr. Voss", 150, "#8f8f9a", "#dcae8c", "the experiment is going… mostly fine."],
  ["Luna", 40, "#f2e6c9", "#f4cfae", "nap. snack. nap."],
  ["Captain Reyes", 10, "#2a1a14", "#c98f68", "charting a course for somewhere warm"],
  ["Juniper", 120, "#5b3a22", "#f0c8a4", undefined],
  ["Ash Vale", 235, "#c9ccd6", "#e2b896", "who needs sleep when there's lore to write"],
  ["Professor Elm", 90, "#6f4a2c", "#efc19a", "grading papers and sighing dramatically"],
  ["Rowan", 20, "#a8431f", "#f3d0b0", "found a lost umbrella. it's mine now."],
  ["Vesper", 300, "#0f0b1a", "#e4b9a0", "midnight thoughts, loud"],
  ["Theo", 180, "#3b2b1c", "#e7bb97", undefined],
  ["Naomi", 345, "#241522", "#d9a782", "new playlist, who dis"],
  ["Bishop", 60, "#4a4a52", "#dcb08a", "keeping watch. someone has to."],
  ["Willow", 135, "#7ac7a0", "#f6d6bf", "touching grass (briefly)"],
  ["Ezra", 215, "#26324a", "#d8a982", "debugging my feelings"],
];
