export type PackKind = "plate" | "banner" | "wreath";
export interface PackItem {
  id: string; kind: PackKind; mode: "svg" | "image" | "video" | "sprite"; name: string; blurb: string;
  /** SVG text, or a data: picture (for a video, the first one is set when it has been turned into frames) */
  art: string; still?: string; moves?: boolean; src?: string;
  cols?: number; rows?: number; frames?: number; dur?: number;
  author?: string; license?: string; pack?: string;
}
export interface PackResult { ok: boolean; error?: string; items: PackItem[]; skipped: { name: string; why: string }[]; name?: string; author?: string; license?: string }
declare const DecoPack: {
  FORMAT: string; VERSION: number;
  KINDS: Record<PackKind, { label: string; w: number; h: number; tol: number; rtol: number; imgMax: number; max: number; par: string; pre: string; hole?: { cx: number; cy: number; r: number } }>;
  LIMITS: { file: number; video: number; items: number; library: number; elements: number; depth: number; name: number; blurb: number; credit: number };
  imageInfo(uri: string): { w: number; h: number; bytes: number; moves: boolean } | null;
  parseMedia(uri: string, fileName: string): PackResult;
  parseFile(text: string, fileName: string): PackResult;
  nearestKind(w: number, h: number, key: string): string;
  idOf(kind: string, art: string): string;
  isId(id: unknown): boolean;
  kindOfId(id: unknown): PackKind | "";
  cleanSvg(text: string, kind: string, o?: { animate?: boolean }): { ok: boolean; error?: string; svg: string; moves: boolean };
  buildPack(meta: { name?: string; author?: string; license?: string }, records: { dkind: string; name: string; blurb?: string; art: string; mode?: string; still?: string; src?: string }[]): string;
  guessKind(text: string): string;
  tidy(s: unknown, n: number): string;
};
export default DecoPack;
