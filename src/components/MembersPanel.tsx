import { type CSSProperties } from "react";
import type { Frame } from "../api";
import { ProfileAvatar } from "./ProfileForms";
import { Wreathed, plateProps } from "../lib/deco";

/** How the AI behind the characters is doing: it decides the colour of the little light beside each character. */
export type Presence = "local" | "ok" | "warn" | "down" | "none" | "checking";

export interface MemberRow {
  id: string;
  name: string;
  /** a still picture for the round avatar (a character with only a 3D model or a video gets their initial instead) */
  avatar: string | null;
  frame?: Frame | null;
  /** what is on their mind (their own words), if they have said something */
  status?: string;
  /** how they are dressed: a nameplate behind the row and a wreath around the picture */
  plate?: string;
  wreath?: string;
}

const LIGHT: Record<Presence, { cls: string; label: string }> = {
  local: { cls: "on", label: "Online (local model)" },
  ok: { cls: "on", label: "Online" },
  warn: { cls: "warn", label: "Needs attention" },
  down: { cls: "off", label: "Offline" },
  none: { cls: "idle", label: "Not set up" },
  checking: { cls: "idle", label: "Checking…" },
};

/** What a row of the characters list carries when it is dragged: the id of the character, to be dropped on a chat. */
export const DRAG_PERSON = "application/x-dorms-chat-character";

export const presenceLabel = (p: Presence) => LIGHT[p].label;

/** The members list itself (a round avatar, a light, and a status bubble above each name); the connected panel gives it real data. */
export function MembersList({
  rows, total, presence, detail, modelLabel, expandedId, query, onQuery, onToggle, expanded, autoStatus, onAutoStatus, autoDeco, onAutoDeco, animate = true, onCollapse, busyIds, note,
}: {
  rows: MemberRow[];
  /** how many characters there are in all, when `rows` is only the ones that match a search */
  total?: number;
  presence: Presence;
  /** the reason, for a light that isn't green */
  detail?: string;
  modelLabel?: string;
  expandedId?: string | null;
  query?: string;
  onQuery?: (q: string) => void;
  onToggle?: (id: string) => void;
  /** what to show under the row that is open (buttons...) */
  expanded?: (r: MemberRow) => React.ReactNode;
  autoStatus?: boolean;
  onAutoStatus?: (on: boolean) => void;
  /** let the model choose decorations for characters that have none */
  autoDeco?: boolean;
  onAutoDeco?: (on: boolean) => void;
  /** whether the decorations move */
  animate?: boolean;
  onCollapse?: () => void;
  busyIds?: Set<string>;
  /** a short message under the options (why statuses aren't being written, for example) */
  note?: string;
}) {
  const L = LIGHT[presence];
  const online = presence === "local" || presence === "ok";
  return (
    <aside className="members" aria-label="Characters">
      <div className="m-head">
        <h4>Characters <span className="m-count">{total ?? rows.length}</span></h4>
        {onCollapse && <button className="iconbtn" aria-label="Hide the characters list" title="Hide" onClick={onCollapse}>›</button>}
      </div>
      <div className={`m-health ${L.cls}`} data-testid="members-health" data-presence={presence} title={detail || L.label}>
        <span className={`m-dot ${L.cls}`} aria-hidden />
        <span className="m-health-text">{presence === "local" ? "Local model · always online" : online ? `${modelLabel || "Model"} · online` : detail || L.label}</span>
      </div>
      {onAutoStatus && (
        <label className="m-auto" title="Characters write what is on their mind. This uses your model (and your tokens, if it is a paid one).">
          <input type="checkbox" checked={!!autoStatus} onChange={(e) => onAutoStatus(e.target.checked)} /> Let characters write their status
        </label>
      )}
      {onAutoDeco && (
        <label className="m-auto" title="Characters with no decorations get a nameplate, background and wreath that suit them. This uses your model (and your tokens, if it is a paid one).">
          <input type="checkbox" data-testid="members-auto-deco" checked={!!autoDeco} onChange={(e) => onAutoDeco(e.target.checked)} /> Let characters choose their decorations
        </label>
      )}
      {note && <div className="m-note" role="status">{note}</div>}
      {onQuery && rows.length > 8 && <input className="m-search" type="search" placeholder="Search characters…" aria-label="Search characters" value={query ?? ""} onChange={(e) => onQuery(e.target.value)} />}
      <div className="m-list">
        {rows.map((r) => {
          const pl = plateProps(r.plate, animate);
          return (
          <div key={r.id} className={`m-row${expandedId === r.id ? " open" : ""} ${pl.className}`} data-member={r.name} data-id={r.id} draggable onDragStart={(e) => { e.dataTransfer.setData(DRAG_PERSON, JSON.stringify([r.id])); e.dataTransfer.effectAllowed = "copy"; }} {...(pl["data-plate"] ? { "data-plate": pl["data-plate"], "data-anim": pl["data-anim"] } : {})} data-wreath-of={r.wreath || undefined}>
            <button className="m-main" onClick={() => onToggle?.(r.id)} aria-expanded={expandedId === r.id}>
              <span className="m-av"><Wreathed wreath={r.wreath} size="sm"><ProfileAvatar name={r.name} size={38} src={r.avatar} frame={r.frame} /></Wreathed><span className={`m-dot ${L.cls}`} title={L.label} data-testid="member-light" /></span>
              <span className="m-text">
                {r.status ? <span className="m-status" data-testid="member-status" style={{ "--lines": expandedId === r.id ? 6 : 2 } as CSSProperties}>{r.status}</span>
                  : busyIds?.has(r.id) ? <span className="m-status ghost">thinking…</span> : null}
                <span className="m-name">{r.name}</span>
              </span>
            </button>
            {expandedId === r.id && expanded && <div className="m-more">{expanded(r)}</div>}
          </div>
          );
        })}
      </div>
    </aside>
  );
}
