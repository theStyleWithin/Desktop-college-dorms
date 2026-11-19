import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, displayName, mediaUrl, type CharStatus, type ProviderHealth } from "../api";
import { useStore } from "../store";
import { errText } from "../lib/util";
import { MembersList, type MemberRow, type Presence } from "./MembersPanel";
import { putCharDeco, useCharDeco } from "../lib/deco";
import { useToast } from "./ui";

const AUTO_KEY = "dorms.members.auto";
const STALE_MS = 12 * 3600 * 1000;

/** Is the model that answers for the characters up? Checked now, every minute while the window is in view, and when the model is changed. */
export function useHealth(deps: unknown[]): ProviderHealth | null {
  const [h, setH] = useState<ProviderHealth | null>(null);
  const check = useCallback(() => { api.providerHealth().then(setH).catch((e) => setH({ state: "none", detail: errText(e), model: "", checked_at: Date.now() })); }, []);
  useEffect(() => {
    setH(null); check();
    const t = window.setInterval(() => { if (!document.hidden) check(); }, 60_000);
    const f = () => check();
    window.addEventListener("focus", f);
    return () => { window.clearInterval(t); window.removeEventListener("focus", f); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return h;
}

/** The characters list, connected to the real characters, the model's health and their statuses. */
export default function MembersRail({ onCollapse }: { onCollapse: () => void }) {
  const { characters, settings, setSettings, go, refresh } = useStore();
  const decoMap = useCharDeco();
  const autoDeco = !!settings.deco?.ai_pick;
  const toast = useToast();
  const health = useHealth([settings.provider, settings.openai_base_url, settings.openai_model, settings.anthropic_model, JSON.stringify(settings.profiles.map((p) => [p.id, p.base_url, p.model]))]);
  const [statuses, setStatuses] = useState<Map<string, CharStatus>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [auto, setAuto] = useState(() => { try { return localStorage.getItem(AUTO_KEY) === "1"; } catch { return false; } });
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [writing, setWriting] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const tried = useRef(new Set<string>());
  const triedDeco = useRef(new Set<string>());
  const pausedUntil = useRef(0);
  const visible = useRef(new Set<string>());

  useEffect(() => { api.listStatuses().then((l) => setStatuses(new Map(l.map((s) => [s.character_id, s])))).catch(() => {}); }, []);
  // a character that is deleted takes its status with it
  useEffect(() => { setStatuses((m) => { const ids = new Set(characters.map((c) => c.id)); let ch = false; const n = new Map(m); for (const k of n.keys()) if (!ids.has(k)) { n.delete(k); ch = true; } return ch ? n : m; }); }, [characters]);

  const presence: Presence = !health ? "checking" : health.state;
  const upNow = presence === "local" || presence === "ok";

  const makeStatus = useCallback(async (id: string, quiet = false) => {
    setBusy((b) => new Set(b).add(id));
    try {
      const s = await api.generateStatus(id);
      setStatuses((m) => new Map(m).set(id, s)); setNote("");
    } catch (e) {
      if (quiet) { pausedUntil.current = Date.now() + 5 * 60_000; setNote(`Couldn't write statuses just now: ${errText(e)}`); }
      else toast(errText(e), "err");
    } finally { setBusy((b) => { const n = new Set(b); n.delete(id); return n; }); }
  }, [toast]);

  const makeDeco = useCallback(async (id: string, quiet = false) => {
    setBusy((b) => new Set(b).add(id));
    try { putCharDeco(id, await api.generateCharDeco(id)); setNote(""); }
    catch (e) {
      if (quiet) { pausedUntil.current = Date.now() + 5 * 60_000; setNote(`Couldn't choose decorations just now: ${errText(e)}`); }
      else toast(errText(e), "err");
    } finally { setBusy((b) => { const n = new Set(b); n.delete(id); return n; }); }
  }, [toast]);

  const rows: MemberRow[] = useMemo(() => {
    const s = q.trim().toLowerCase();
    return characters
      .filter((c) => !s || displayName(c).toLowerCase().includes(s))
      .map((c) => ({ id: c.id, name: displayName(c), avatar: c.media?.kind === "image" || c.media?.kind === "gif" ? mediaUrl(c) : null, frame: c.frame, status: statuses.get(c.id)?.text, plate: decoMap.get(c.id)?.plate, wreath: decoMap.get(c.id)?.wreath }));
  }, [characters, statuses, q, decoMap]);

  // when "let characters write their status" is on: the ones in view that have none (or an old one), one at a time, never in a burst
  const rowsKey = rows.map((r) => r.id).join(",");
  useEffect(() => {
    if ((!auto && !autoDeco) || !upNow) return;
    const root = document.querySelector(".members .m-list");
    if (!root) return;
    visible.current = new Set();
    const io = new IntersectionObserver((es) => { for (const e of es) { const id = (e.target as HTMLElement).dataset.id; if (!id) continue; if (e.isIntersecting) visible.current.add(id); else visible.current.delete(id); } }, { root, rootMargin: "40px" });
    root.querySelectorAll<HTMLElement>(".m-row[data-id]").forEach((n) => io.observe(n));
    let stop = false;
    const tick = async () => {
      if (stop || document.hidden || Date.now() < pausedUntil.current) return;
      const id = auto ? [...visible.current].find((i) => { if (tried.current.has(i)) return false; const s = statuses.get(i); return !s || (s.source === "ai" && Date.now() - s.updated_at > STALE_MS); }) : undefined;
      if (id) { tried.current.add(id); await makeStatus(id, true); return; }
      // then the ones in view that have no decorations at all (a look chosen by hand, or by the model before, is never replaced)
      const dec = autoDeco ? [...visible.current].find((i) => !triedDeco.current.has(i) && !decoMap.has(i)) : undefined;
      if (dec) { triedDeco.current.add(dec); await makeDeco(dec, true); }
    };
    const t = window.setInterval(() => { void tick(); }, 2500);
    return () => { stop = true; window.clearInterval(t); io.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, autoDeco, upNow, rowsKey, statuses.size, decoMap.size]);

  const chat = async (id: string) => {
    const c = characters.find((x) => x.id === id); if (!c) return;
    try { const ch = await api.createChat(null, displayName(c), "dm", [c.id]); await refresh(); go({ page: "chat", chatId: ch.id }); } catch (e) { toast(errText(e), "err"); }
  };
  const saveOwn = async (id: string) => {
    try { const s = await api.setStatus(id, draft); setStatuses((m) => { const n = new Map(m); if (s) n.set(id, s); else n.delete(id); return n; }); setWriting(null); } catch (e) { toast(errText(e), "err"); }
  };

  return (
    <div className="members-wrap" data-testid="members">
      <MembersList rows={rows} total={characters.length} presence={presence} detail={health?.detail} modelLabel={health?.model}
        expandedId={open} onToggle={(id) => { setOpen(open === id ? null : id); setWriting(null); }} query={q} onQuery={setQ}
        autoStatus={auto} onAutoStatus={(on) => { setAuto(on); tried.current = new Set(); pausedUntil.current = 0; setNote(""); try { localStorage.setItem(AUTO_KEY, on ? "1" : "0"); } catch { /* storage unavailable */ } }}
        autoDeco={autoDeco} animate={settings.deco?.animate !== false}
        onAutoDeco={(on) => { triedDeco.current = new Set(); pausedUntil.current = 0; setNote(""); void setSettings({ ...settings, deco: { ...settings.deco, ai_pick: on } }).catch((e) => toast(errText(e), "err")); }}
        onCollapse={onCollapse} busyIds={busy} note={note}
        expanded={(r) => writing === r.id ? (
          <div className="m-write">
            <input type="text" autoFocus maxLength={80} value={draft} placeholder="What's on their mind?" aria-label="Status" onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void saveOwn(r.id); if (e.key === "Escape") setWriting(null); }} />
            <button className="btn" onClick={() => void saveOwn(r.id)}>Save</button>
            <button className="btn" onClick={() => { setDraft(""); void saveOwn(r.id); }}>Clear</button>
          </div>
        ) : (<>
          <button className="btn" onClick={() => void chat(r.id)}>💬 Chat</button>
          <button className="btn" onClick={() => go({ page: "editor", id: r.id })}>✎ Edit</button>
          <button className="btn" disabled={busy.has(r.id)} onClick={() => void makeStatus(r.id)}>↻ New status</button>
          <button className="btn" disabled={busy.has(r.id)} onClick={() => void makeDeco(r.id)} title="Let the model choose a new nameplate, background and wreath for them">✨ New look</button>
          <button className="btn" onClick={() => { setDraft(statuses.get(r.id)?.text ?? ""); setWriting(r.id); }}>✏ Write status</button>
        </>)} />
    </div>
  );
}
