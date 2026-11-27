export interface DecoItem { id: string; name: string; blurb: string; anim?: boolean }
export interface DecoTheme { id: string; name: string; blurb: string; plate: string; bg: string; wreath: string; season?: string }
export interface DecoGroup { name?: string; /** the calendar window it opens in ("thanksgiving", "christmas", "hanukkah:3"); none means always open */ season?: string; plate?: string[]; bg?: string[]; wreath?: string[] }
export interface DecoSeries { id: string; name: string; blurb: string; season?: string; groups: DecoGroup[] }
export interface SeasonStatus { open: boolean; from?: number; to?: number }
export interface DecoProfile { plate: string; bg: string; wreath: string; animate: boolean }
export interface DecoServer { tag: string; tagColor: string; tagGlyph: string; bannerPreset: string; bannerImg: string }
export interface DecoBanner { id: string; name: string; css: string }
declare const DecoCore: {
  /** is this season open on this day (a set with no season is always open)? */
  isOpen(season: string | undefined, now?: number): boolean;
  status(season: string | undefined, now?: number): SeasonStatus;
  /** "Fri, Dec 4" (with the year when it is next year): when a locked season next opens, or "" */
  opensLabel(season: string | undefined, now?: number): string;
  /** when an open season closes ("" for one that is always open) */
  untilLabel(season: string | undefined, now?: number): string;
  /** the next set to open within six weeks, if any */
  nextOpening(now?: number): { name: string; season: string; from: number } | null;
  /** is this nameplate, background or wreath in a season that is closed right now? */
  lockedNow(id: string, now?: number): boolean;
  /** the season each locked decoration belongs to */
  LOCKS: Record<string, string>;
  hanukkahNight1(year: number): Date;
  SERIES: DecoSeries[];
  seriesOfTheme(id: string): string;
  buildArt(animated: boolean): { wreath: Record<string, string>; bg: Record<string, string>; plate: Record<string, string> };
  plateOk(id: string): boolean;
  uri(svg: string): string;
  BACKGROUNDS: DecoItem[];
  WREATHS: DecoItem[];
  PLATES: DecoItem[];
  THEMES: DecoTheme[];
  TAG_COLORS: [string, string][];
  TAG_GLYPHS: [string, string][];
  BANNERS: DecoBanner[];
  plate(id: string): DecoItem;
  banner(id: string): DecoBanner | null;
  cleanTag(s: string): string;
  tagOk(s: string): boolean;
  normProfile(r: Partial<DecoProfile> | null | undefined): DecoProfile;
  normServer(r: Partial<DecoServer> | null | undefined): DecoServer;
  bannerCss(s: DecoServer): string;
};
export default DecoCore;
