import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type GalleryComment } from "../api";
import { errText, timeAgo } from "../lib/util";
import { useToast } from "./ui";

/**
 * The comments under a picture in the Gallery: the person's own notes about a picture they like, kept only on this device. It works like a
 * forum thread: any number of comments, written whenever, and each one can be answered (with answers to answers, shown indented).
 */
const MAX_INDENT = 6;

function Composer({ placeholder, busy, onPost, onCancel, autoFocus, testid }: { placeholder: string; busy: boolean; onPost: (t: string) => void; onCancel?: () => void; autoFocus?: boolean; testid: string }) {
  const [t, setT] = useState("");
  const post = () => { if (t.trim() && !busy) { onPost(t); setT(""); } };
  return (
    <div className="pc-composer">
      <textarea value={t} rows={2} autoFocus={autoFocus} placeholder={placeholder} aria-label={placeholder} data-testid={`${testid}-text`} maxLength={20000}
        onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); post(); } if (e.key === "Escape") { e.stopPropagation(); (e.target as HTMLElement).blur(); onCancel?.(); } }} />
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn primary sm" disabled={!t.trim() || busy} data-testid={`${testid}-post`} onClick={post}>{onCancel ? "Reply" : "Post comment"}</button>
        {onCancel ? <button type="button" className="btn ghost sm" onClick={onCancel}>Cancel</button> : <small className="muted">Ctrl+Enter posts</small>}
      </div>
    </div>
  );
}

export default function PictureComments({ picKey, author, onCount }: { picKey: string; author: string; onCount: (n: number) => void }) {
  const toast = useToast();
  const [all, setAll] = useState<GalleryComment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const load = useCallback(async () => {
    try { const l = await api.galleryComments(picKey); setAll(l); onCount(l.length); } catch (e) { toast(errText(e), "err"); setAll([]); }
  }, [picKey, onCount, toast]);
  useEffect(() => { setAll(null); setReplyTo(null); setEditing(null); void load(); }, [load]);

  const kids = useMemo(() => {
    const m = new Map<string | null, GalleryComment[]>();
    for (const c of all ?? []) { const k = c.parent_id && all!.some((x) => x.id === c.parent_id) ? c.parent_id : null; (m.get(k) ?? m.set(k, []).get(k)!).push(c); }
    return m;
  }, [all]);

  const post = async (parent: string | null, text: string) => {
    setBusy(true);
    try { await api.addGalleryComment(picKey, parent, author, text); setReplyTo(null); await load(); } catch (e) { toast(errText(e), "err"); } finally { setBusy(false); }
  };
  const saveEdit = async (id: string) => {
    setBusy(true);
    try { await api.editGalleryComment(id, editText); setEditing(null); await load(); } catch (e) { toast(errText(e), "err"); } finally { setBusy(false); }
  };
  const count = (id: string): number => (kids.get(id) ?? []).reduce((n, c) => n + 1 + count(c.id), 0);
  const remove = async (c: GalleryComment) => {
    const n = count(c.id);
    if (!window.confirm(n ? `Delete this comment and its ${n} repl${n === 1 ? "y" : "ies"}?` : "Delete this comment?")) return;
    try { await api.deleteGalleryComment(c.id); await load(); } catch (e) { toast(errText(e), "err"); }
  };

  const node = (c: GalleryComment, depth: number): JSX.Element => (
    <div key={c.id} className="pc-node" style={{ marginLeft: Math.min(depth, MAX_INDENT) > 0 ? 14 : 0 }} data-comment={c.id} data-depth={depth}>
      <div className="pc-comment">
        <div className="pc-head"><b>{c.author || "Me"}</b><small title={new Date(c.created_at).toLocaleString()}>{timeAgo(c.created_at)}{c.edited_at ? " · edited" : ""}</small></div>
        {editing === c.id ? (
          <div className="pc-composer">
            <textarea value={editText} rows={3} autoFocus aria-label="Edit comment" data-testid="comment-edit-text" maxLength={20000} onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void saveEdit(c.id); } if (e.key === "Escape") { e.stopPropagation(); setEditing(null); } }} />
            <div className="row" style={{ gap: 8 }}><button type="button" className="btn primary sm" disabled={!editText.trim() || busy} data-testid="comment-edit-save" onClick={() => void saveEdit(c.id)}>Save</button><button type="button" className="btn ghost sm" onClick={() => setEditing(null)}>Cancel</button></div>
          </div>
        ) : <div className="pc-body" data-testid="comment-body">{c.body}</div>}
        {editing !== c.id ? (
          <div className="pc-acts">
            <button type="button" className="btn ghost sm" data-testid="comment-reply" onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}>Reply</button>
            <button type="button" className="btn ghost sm" data-testid="comment-edit" onClick={() => { setEditing(c.id); setEditText(c.body); }}>Edit</button>
            <button type="button" className="btn ghost sm" data-testid="comment-delete" onClick={() => void remove(c)}>Delete</button>
          </div>
        ) : null}
        {replyTo === c.id ? <Composer placeholder={`Reply to ${c.author || "this comment"}…`} busy={busy} autoFocus testid="reply" onPost={(t) => void post(c.id, t)} onCancel={() => setReplyTo(null)} /> : null}
      </div>
      {(kids.get(c.id) ?? []).map((k) => node(k, depth + 1))}
    </div>
  );

  const top = kids.get(null) ?? [];
  return (
    <div className="pc" data-testid="picture-comments">
      <h3 className="pc-title">Comments{all ? <small> · {all.length}</small> : null}</h3>
      <Composer placeholder="Write a comment about this picture…" busy={busy} testid="comment" onPost={(t) => void post(null, t)} />
      <div className="pc-list">
        {all === null ? <p className="hint">Loading…</p> : !top.length ? <p className="hint" data-testid="comments-empty">No comments yet. They stay on this device, and you can write as many as you like.</p> : top.map((c) => node(c, 0))}
      </div>
    </div>
  );
}
