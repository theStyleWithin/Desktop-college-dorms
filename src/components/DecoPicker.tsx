import { useState, type ReactNode } from "react";
import DecoCore, { type DecoItem } from "../lib/decoCore";
import { DecoBg, Wreathed, plateProps } from "../lib/deco";

export interface Look { plate: string; bg: string; wreath: string }
const VIEW_KEY = "dorms.deco.view";

const byId = (list: DecoItem[]) => Object.fromEntries(list.map((x) => [x.id, x])) as Record<string, DecoItem>;
const PL = byId(DecoCore.PLATES), BG = byId(DecoCore.BACKGROUNDS), WR = byId(DecoCore.WREATHS);

const loadView = (): { series: string; kind: string } => {
  try { const v = JSON.parse(localStorage.getItem(VIEW_KEY) || "null"); if (v && typeof v === "object") return { series: String(v.series || "all"), kind: String(v.kind || "all") }; } catch { /* default */ }
  return { series: "all", kind: "all" };
};

/**
 * Nameplates, profile backgrounds and avatar wreaths, filed by collection (Classic, Kawaii Boba Tea, Lunar New Year, Anime), with themes that
 * set all three at once. Ported from Anti-Social's settings. `avatar` draws the picture the wreaths are shown on.
 */
export default function DecoPicker({ value, animate, onChange, avatar, name, children }: {
  value: Look; animate: boolean; onChange: (patch: Partial<Look>) => void;
  /** the picture used in the previews */
  avatar: (size: number) => ReactNode; name: string; children?: ReactNode;
}) {
  const [view, setViewState] = useState(loadView);
  const setView = (p: Partial<{ series: string; kind: string }>) => setViewState((v) => { const n = { ...v, ...p }; try { localStorage.setItem(VIEW_KEY, JSON.stringify(n)); } catch { /* not remembered */ } return n; });
  const cur = value;
  const want = (k: string) => view.kind === "all" || view.kind === k;

  const themeCard = (t: (typeof DecoCore.THEMES)[number]) => (
    <button key={t.id} type="button" className={`theme-card${cur.plate === t.plate && cur.bg === t.bg && cur.wreath === t.wreath ? " on" : ""}`} data-theme-pick={t.id} onClick={() => onChange({ plate: t.plate, bg: t.bg, wreath: t.wreath })}>
      <span className="theme-av"><span className="dw-av"><Wreathed wreath={t.wreath}>{avatar(56)}</Wreathed></span></span>
      <span><b>{t.name}</b><small>{t.blurb}</small></span>
    </button>
  );
  const platePick = (p: DecoItem) => (
    <button key={"plate-" + p.id} type="button" className={`plate-pick m-row-like ${plateProps(p.id, animate).className}${cur.plate === p.id ? " on" : ""}`} aria-pressed={cur.plate === p.id} data-plate-pick={p.id}
      {...(plateProps(p.id, animate)["data-plate"] ? { "data-plate": p.id, "data-anim": animate ? "on" : "off" } : {})} onClick={() => onChange({ plate: p.id })}>
      <span>{avatar(32)}</span>
      <span className="names"><b className="m-name">{name}</b><small className="m-status">{p.name} · {p.blurb}</small></span>
    </button>
  );
  const bgPick = (b: DecoItem) => (
    <button key={"bg-" + b.id} type="button" className={`bg-pick${(cur.bg || "none") === b.id ? " on" : ""}`} aria-pressed={(cur.bg || "none") === b.id} data-bg-pick={b.id} onClick={() => onChange({ bg: b.id === "none" ? "" : b.id })}>
      {b.id === "none" ? <span className="bg-prev none">None</span> : <span className="bg-prev-wrap"><DecoBg bg={b.id} /></span>}
      <b>{b.name}</b><small>{b.blurb}</small>
    </button>
  );
  const wrPick = (w: DecoItem) => (
    <button key={"wr-" + w.id} type="button" className={`wr-pick${(cur.wreath || "none") === w.id ? " on" : ""}`} aria-pressed={(cur.wreath || "none") === w.id} data-wreath-pick={w.id} onClick={() => onChange({ wreath: w.id === "none" ? "" : w.id })}>
      <span className="wr-av"><span className="dw-av"><Wreathed wreath={w.id === "none" ? "" : w.id}>{avatar(56)}</Wreathed></span></span><b>{w.name}</b><small>{w.blurb}</small>
    </button>
  );
  const KINDS: [string, string, string, (i: DecoItem) => ReactNode, Record<string, DecoItem>][] = [
    ["plate", "Nameplates", "plate-grid", platePick, PL], ["bg", "Profile backgrounds", "bg-grid", bgPick, BG], ["wreath", "Avatar wreaths", "wr-grid", wrPick, WR],
  ];
  const chip = (label: string, on: boolean, fn: () => void) => <button key={label} className={`fp-chip${on ? " on" : ""}`} type="button" aria-pressed={on} onClick={fn}>{label}</button>;
  const wearing = [cur.plate !== "none" ? "Nameplate: " + PL[cur.plate]?.name : "", cur.bg ? "Background: " + BG[cur.bg]?.name : "", cur.wreath ? "Wreath: " + WR[cur.wreath]?.name : ""].filter(Boolean);

  const seriesBlock = (se: (typeof DecoCore.SERIES)[number]) => {
    const themes = DecoCore.THEMES.filter((t) => DecoCore.seriesOfTheme(t.id) === se.id);
    const kinds = (g: (typeof se.groups)[number]) => KINDS.filter(([k]) => want(k) && ((g as Record<string, string[] | undefined>)[k] ?? []).length).map(([k, label, cls, build, map]) => (
      <div className="dc-kind" key={k}><h6>{label}</h6><div className={cls} role="group" aria-label={label}>{((g as Record<string, string[]>)[k]).map((id) => build(map[id]))}</div></div>
    ));
    const body = se.groups.map((g, i) => { const ks = kinds(g); return ks.length ? <div className="dc-group" key={i}>{g.name ? <h5>{g.name}</h5> : null}{ks}</div> : null; }).filter(Boolean);
    if (!body.length && !(view.kind === "all" && themes.length)) return null;
    return (
      <section className="dc-series" aria-label={se.name} key={se.id}>
        <h4>{se.name}<small>{se.blurb}</small></h4>
        {view.kind === "all" && themes.length ? <div className="theme-grid">{themes.map(themeCard)}</div> : null}
        {body}
      </section>
    );
  };
  const shown = DecoCore.SERIES.filter((se) => view.series === "all" || view.series === se.id).map(seriesBlock).filter(Boolean);

  return (
    <div className="dc-picker" data-testid="deco-picker">
      <div className="dc-wear">
        <span data-testid="deco-wearing">{wearing.length ? "Wearing: " + wearing.join(" · ") : "Wearing: nothing yet"}</span>
        {wearing.length ? <button className="btn" type="button" onClick={() => onChange({ plate: "none", bg: "", wreath: "" })}>Take it all off</button> : null}
      </div>
      {children}
      <div className="dc-filters" role="group" aria-label="Collection">
        {chip("All collections", view.series === "all", () => setView({ series: "all" }))}
        {DecoCore.SERIES.map((se) => chip(se.name, view.series === se.id, () => setView({ series: se.id })))}
      </div>
      <div className="dc-filters" role="group" aria-label="Kind">
        {chip("Everything", view.kind === "all", () => setView({ kind: "all" }))}
        {KINDS.map(([k, label]) => chip(label, view.kind === k, () => setView({ kind: k })))}
      </div>
      <div className="dc-none" role="group" aria-label="Take one off">
        {want("plate") ? platePick(PL.none) : null}{want("bg") ? bgPick(BG.none) : null}{want("wreath") ? wrPick(WR.none) : null}
      </div>
      {shown.length ? shown : <p className="fine">Nothing in that collection for that kind.</p>}
    </div>
  );
}
