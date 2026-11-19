export interface DecoItem { id: string; name: string; blurb: string; anim?: boolean }
export interface DecoTheme { id: string; name: string; blurb: string; plate: string; bg: string; wreath: string }
export interface DecoGroup { name?: string; plate?: string[]; bg?: string[]; wreath?: string[] }
export interface DecoSeries { id: string; name: string; blurb: string; groups: DecoGroup[] }
export interface DecoProfile { plate: string; bg: string; wreath: string; animate: boolean }
export interface DecoServer { tag: string; tagColor: string; tagGlyph: string; bannerPreset: string; bannerImg: string }
export interface DecoBanner { id: string; name: string; css: string }
declare const DecoCore: {
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
