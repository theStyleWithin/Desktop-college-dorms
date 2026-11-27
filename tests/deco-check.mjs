#!/usr/bin/env node
/* Checks the built-in profile decorations (src/lib/decoCore.js): every one has art in a moving and a still version at the right shape, every collection and
   theme points at real things, and the holiday sets open and close by the calendar (Hanukkah from the Hebrew calendar), the same rules as the author's app
   Anti-Social. Run: node tests/deco-check.mjs (CI runs it). */
let bad = 0; const t = (name, cond, extra) => { if (cond) console.log('ok    ' + name); else { bad++; console.log('FAIL  ' + name + (extra ? '\n        ' + extra : '')); } };
const svg = (w, h, body, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" ${attrs}>${body}</svg>`;

/* the built-in decorations (src/lib/decoCore.js): every one has art in a moving and a still version, at the right shape */
const D = (await import('../src/lib/decoCore.js')).default, moving = D.buildArt(true), still = D.buildArt(false);
const lists = [['plate', D.PLATES, 'plate', 240, 44], ['bg', D.BACKGROUNDS, 'bg', 1200, 200], ['wreath', D.WREATHS, 'wreath', 144, 144]];
for (const [name, list, key, w, h] of lists) {
  const classic = new Set(D.SERIES.find(x => x.id === 'classic').groups.flatMap(g => g.plate || []));      // the Classic nameplates are drawn in CSS (style.css), not SVG
  const ids = list.filter(x => x.id !== 'none' && !x.custom && !classic.has(x.id)).map(x => x.id);
  const noArt = ids.filter(id => !moving[key][id] || !still[key][id]);
  const noSize = ids.filter(id => moving[key][id] && !new RegExp(`viewBox="0 0 ${w} ${h}"`).test(moving[key][id]));
  const moves = ids.filter(id => /<animate/.test(still[key][id] || ''));
  t(name + ' decorations all have art in both versions (' + ids.length + ')', !noArt.length, noArt.join());
  t(name + ' decorations are all ' + w + ' × ' + h, !noSize.length, noSize.join());
  t(name + ' still versions have no animation', !moves.length, moves.join());
}
const listed = new Set(D.SERIES.flatMap(se => se.groups.flatMap(g => [...(g.plate || []), ...(g.bg || []), ...(g.wreath || [])])));
const all = [...D.PLATES, ...D.BACKGROUNDS, ...D.WREATHS].filter(x => x.id !== 'none' && !x.custom).map(x => x.id);
t('every built-in decoration is in a collection, and every collection entry exists', all.every(id => listed.has(id)) && [...listed].every(id => all.includes(id)), 'missing: ' + all.filter(id => !listed.has(id)).join() + ' unknown: ' + [...listed].filter(id => !all.includes(id)).join());
t('every theme points at real decorations', D.THEMES.every(th => D.PLATES.some(x => x.id === th.plate) && D.BACKGROUNDS.some(x => x.id === th.bg) && D.WREATHS.some(x => x.id === th.wreath) && D.seriesOfTheme(th.id)));
t('the Vibrant Pumpkin and Gobble Gobble Turkey sets each have three nameplates, three banners and three avatar decorations', ['vibrantpumpkin', 'gobblegobble'].every(id => { const g = D.SERIES.find(x => x.id === id).groups[0]; return g.plate.length === 3 && g.bg.length === 3 && g.wreath.length === 3; }));

/* the holiday sets: two Christmas sets of 3/3/3, and eight nights of Hanukkah, each with its own nameplate, banner and avatar decoration */
t('the two Christmas sets each have three nameplates, three banners and three avatar decorations', ['cosychristmas', 'santasparkle'].every(id => { const g = D.SERIES.find(x => x.id === id).groups[0]; return g.plate.length === 3 && g.bg.length === 3 && g.wreath.length === 3; }));
const hk = D.SERIES.find(x => x.id === 'hanukkah');
t('Hanukkah has eight nights, each with one nameplate, one banner and one avatar decoration', hk.groups.length === 8 && hk.groups.every((g, i) => g.plate.join() === 'hk' + (i + 1) && g.bg.join() === 'hk' + (i + 1) && g.wreath.join() === 'hk' + (i + 1)));
t('each night has its own theme', Array.from({ length: 8 }, (_, i) => D.THEMES.find(x => x.id === 'hanukkah' + (i + 1))).every((th, i) => th && th.plate === 'hk' + (i + 1) && th.bg === 'hk' + (i + 1) && th.wreath === 'hk' + (i + 1) && D.seriesOfTheme(th.id) === 'hanukkah'));
// night N lights N candles plus the shamash (the inner flame colour #fffbe0 appears once per flame; night 7 also has three oil-jar flames)
const flames = svg => (svg.match(/fill="#fffbe0"/g) || []).length;
t('every nameplate shows the right number of lit candles (night N: N and the shamash)', Array.from({ length: 8 }, (_, i) => i + 1).every(n => flames(moving.plate['hk' + n]) === n + 1 + (n === 7 ? 3 : 0)), Array.from({ length: 8 }, (_, i) => flames(moving.plate['hk' + (i + 1)])).join());
t('every Hanukkah banner shows the right number of lit candles', Array.from({ length: 8 }, (_, i) => i + 1).every(n => flames(moving.bg['hk' + n]) >= n + 1), Array.from({ length: 8 }, (_, i) => flames(moving.bg['hk' + (i + 1)])).join());
t('every Hanukkah avatar decoration has a straight hanukkiah with the right number of lit candles (night N: N and the shamash), not a ring of candles', Array.from({ length: 8 }, (_, i) => i + 1).every(n => flames(moving.wreath['hk' + n]) === n + 1 + (n === 7 ? 7 : n === 8 ? 1 : 0)), Array.from({ length: 8 }, (_, i) => flames(moving.wreath['hk' + (i + 1)])).join());
t('night 6 is "Light in the Window", with a hanukkiah in a window', D.SERIES.find(x => x.id === 'hanukkah').groups[5].name === 'Night 6: Light in the Window' && !/Star of David/.test(JSON.stringify(D.SERIES)));
t('the Hanukkah dreidels carry the four Hebrew letters', /נ/.test(moving.plate.hk2) && /ג/.test(moving.bg.hk2) && /ה/.test(moving.bg.hk2) && /ש/.test(moving.bg.hk2));

/* the holiday calendar: seasonal sets open in a window that comes round every year */
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
t('the first night of Hanukkah is right for 2024 to 2030', [[2024, '2024-12-25'], [2025, '2025-12-14'], [2026, '2026-12-04'], [2027, '2027-12-24'], [2028, '2028-12-12'], [2029, '2029-12-01'], [2030, '2030-12-20']].every(([y, d]) => iso(D.hanukkahNight1(y)) === d), [2024, 2025, 2026, 2027, 2028, 2029, 2030].map(y => iso(D.hanukkahNight1(y))).join());
t('the Hebrew calendar agrees with the system calendar for every year from 1990 to 2100', (() => {
  const fmt = new Intl.DateTimeFormat('en-u-ca-hebrew-nu-latn', { day: 'numeric', month: 'long', timeZone: 'UTC' }); const wrong = [];
  for (let y = 1990; y <= 2100; y++) { let found = null; for (let d = new Date(Date.UTC(y, 10, 1)); d < new Date(Date.UTC(y + 1, 0, 10)); d = new Date(d.getTime() + 864e5)) { const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value])); if (p.day === '25' && /Kislev/i.test(p.month)) { found = d; break; } } if (!found || iso(D.hanukkahNight1(y)) !== new Date(found.getTime() - 864e5).toISOString().slice(0, 10)) wrong.push(y); }
  return !wrong.length; })());
const hkg = D.SERIES.find(x => x.id === 'hanukkah').groups;
t('every Hanukkah night, set and theme carries its night (hanukkah:1 to hanukkah:8)', hkg.every((g, i) => g.season === 'hanukkah:' + (i + 1)) && Array.from({ length: 8 }, (_, i) => D.THEMES.find(x => x.id === 'hanukkah' + (i + 1))).every((th, i) => th.season === 'hanukkah:' + (i + 1)));
t('2026: one more night opens each day from the 4th to the 11th', Array.from({ length: 8 }, (_, i) => hkg.filter(g => D.isOpen(g.season, at(2026, 12, 4 + i, 12))).length).join() === '1,2,3,4,5,6,7,8');
t('2026: a night opens at midnight and not before', !D.isOpen('hanukkah:1', at(2026, 12, 3, 23, 59)) && D.isOpen('hanukkah:1', at(2026, 12, 4, 0, 0)) && !D.isOpen('hanukkah:2', at(2026, 12, 4, 23, 59)) && D.isOpen('hanukkah:2', at(2026, 12, 5)));
t('Hanukkah stays open a week after the festival ends, then locks until next year', D.isOpen('hanukkah:3', at(2026, 12, 18, 23, 0)) && !D.isOpen('hanukkah:3', at(2026, 12, 19)) && !D.isOpen('hanukkah:1', at(2027, 6, 1)));
t('the same nights open on the right dates in 2027 (first night 24 December)', D.isOpen('hanukkah:1', at(2027, 12, 24)) && !D.isOpen('hanukkah:2', at(2027, 12, 24, 12)) && !D.isOpen('hanukkah:1', at(2027, 12, 23, 23)));
t('Christmas opens on 18 December, a week early, and stays open to 6 January', ['christmas'].every(s => !D.isOpen(s, at(2026, 12, 17, 23)) && D.isOpen(s, at(2026, 12, 18)) && D.isOpen(s, at(2027, 1, 6, 23)) && !D.isOpen(s, at(2027, 1, 7)) && D.isOpen(s, at(2027, 12, 20))));
t('Thanksgiving opens a week before the fourth Thursday of November and closes a week after', !D.isOpen('thanksgiving', at(2026, 11, 18, 23)) && D.isOpen('thanksgiving', at(2026, 11, 19)) && D.isOpen('thanksgiving', at(2026, 12, 3, 23)) && !D.isOpen('thanksgiving', at(2026, 12, 4)) && D.isOpen('thanksgiving', at(2027, 11, 18)) && !D.isOpen('thanksgiving', at(2027, 11, 17, 23)));
t('both Thanksgiving sets, both Christmas sets and their themes carry their season', ['vibrantpumpkin', 'gobblegobble'].every(id => D.SERIES.find(x => x.id === id).season === 'thanksgiving' && D.THEMES.find(x => x.id === id).season === 'thanksgiving') && ['cosychristmas', 'santasparkle'].every(id => D.SERIES.find(x => x.id === id).season === 'christmas' && D.THEMES.find(x => x.id === id).season === 'christmas'));
t('a closed set says when it next opens, with the year when that is next year', D.opensLabel('christmas', at(2026, 12, 10)).includes('18') && /2027/.test(D.opensLabel('hanukkah:1', at(2026, 12, 25))) && !/2026/.test(D.opensLabel('christmas', at(2026, 12, 10))) && D.untilLabel('christmas', at(2026, 12, 20)).includes('6'));
t('the "next up" line points at the right set and only within six weeks', D.nextOpening(at(2026, 11, 26)).season === 'hanukkah:1' && /Night 4/.test(D.nextOpening(at(2026, 12, 6, 10)).name) && D.nextOpening(at(2026, 12, 12)).season === 'christmas' && D.nextOpening(at(2027, 1, 10)) === null && /Thanksgiving|Pumpkin|Turkey/.test(D.nextOpening(at(2027, 10, 20)).name));
t('the made-up members never wear a set that is locked, in any month', [at(2026, 7, 1), at(2026, 11, 26), at(2026, 12, 6), at(2027, 2, 1)].every(now => { for (let i = 0; i < 400; i++) { const id = 'acct' + i; if (D.lockedNow(D.ghostPlate(id, now), now) || D.lockedNow(D.ghostWreath(id, now), now)) return false; } return true; }));
console.log(bad ? `\n${bad} problem${bad === 1 ? '' : 's'}` : '\nall good'); process.exit(bad ? 1 : 0);

