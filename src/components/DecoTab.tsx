import { useState } from "react";
import { DEFAULT_DECO, api, displayName, profileAvatar, type UserDeco } from "../api";
import DecoCore from "../lib/decoCore";
import { DecoBg, TagChip, Wreathed, plateProps, putCharDeco, useCharDeco } from "../lib/deco";
import { errText } from "../lib/util";
import { useStore } from "../store";
import DecoPicker, { type Look } from "./DecoPicker";
import { ProfileAvatar } from "./ProfileForms";
import { Modal, useToast } from "./ui";

/** The user's profile as a card: banner (a moving background, else a plain banner), picture with its wreath, name with its tag, and the nameplate row. */
export function ProfileCard({ deco, name, src, frame }: { deco: UserDeco; name: string; src: string | null; frame?: Parameters<typeof ProfileAvatar>[0]["frame"] }) {
  const pl = plateProps(deco.plate, deco.animate);
  const banner = deco.bg ? null : DecoCore.banner(deco.banner)?.css;
  return (
    <div className="profile-card" data-testid="profile-card">
      <div className="profile-card-banner">
        <DecoBg bg={deco.bg} height={110}>{banner ? <span className="deco-bg" style={{ background: banner }} /> : null}</DecoBg>
      </div>
      <div className="profile-card-me">
        <Wreathed wreath={deco.wreath}><ProfileAvatar name={name} size={64} src={src} frame={frame} /></Wreathed>
        <div className={`profile-card-row ${pl.className}`} {...(pl["data-plate"] ? { "data-plate": pl["data-plate"], "data-anim": pl["data-anim"] } : {})}>
          <b className="m-name">{name}</b><TagChip tag={deco.tag} color={deco.tag_color} glyph={deco.tag_glyph} />
        </div>
      </div>
    </div>
  );
}

/** Settings → Decorations: dress your profile, set your name tag and banner, and let the model dress your characters. */
export default function DecoTab() {
  const { settings, setSettings, session, characters } = useStore();
  const toast = useToast();
  const charDeco = useCharDeco();
  const [tagModal, setTagModal] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const deco = settings.deco ?? DEFAULT_DECO;
  const handle = session.profile?.handle ?? "Guest";
  const set = async (patch: Partial<UserDeco>) => {
    try { await setSettings({ ...settings, deco: { ...deco, ...patch } }); } catch (e) { toast(errText(e), "err"); }
  };
  const avatar = (size: number) => <ProfileAvatar name={handle} size={size} src={profileAvatar(session.profile)} frame={session.profile?.avatar_frame} />;

  // dress every character that has nothing yet, one at a time
  const missing = characters.filter((c) => !charDeco.has(c.id));
  const dressAll = async () => {
    for (let i = 0; i < missing.length; i++) {
      const c = missing[i];
      setBusy(`Choosing for ${displayName(c)} (${i + 1} of ${missing.length})…`);
      try { putCharDeco(c.id, await api.generateCharDeco(c.id)); } catch (e) { toast(errText(e), "err"); break; }
    }
    setBusy(null);
  };

  return (
    <div className="dc-tab" data-testid="deco-tab">
      <h3>Profile decorations</h3>
      <p className="sub">Dress up your profile. A nameplate sits behind your name at the bottom left, a wreath goes around your picture, and a moving background fills your profile card. Everything is filed by collection and kind, so pick a filter to narrow the list.</p>
      <ProfileCard deco={deco} name={handle} src={profileAvatar(session.profile)} frame={session.profile?.avatar_frame} />
      <DecoPicker value={{ plate: deco.plate, bg: deco.bg, wreath: deco.wreath }} animate={deco.animate} avatar={avatar} name={handle} onChange={(p: Partial<Look>) => void set(p)}>
        <div className="btnrow"><button className="btn" type="button" onClick={() => setTagModal(true)}>Name tag and banner…</button></div>
      </DecoPicker>
      <label className="check" style={{ display: "flex", gap: 8, margin: "14px 0" }}>
        <input type="checkbox" checked={deco.animate} onChange={(e) => void set({ animate: e.target.checked })} />
        <span>Animate decorations<small className="muted" style={{ display: "block" }}>Things move a little. Turned off automatically if your device asks for less motion.</small></span>
      </label>

      <h3 style={{ marginTop: 26 }}>Your characters</h3>
      <p className="sub">Each character can wear decorations too: choose them in the character's editor, or let the model choose ones that suit who they are.</p>
      <label className="check" style={{ display: "flex", gap: 8, margin: "10px 0" }}>
        <input type="checkbox" data-testid="deco-ai-pick" checked={deco.ai_pick} onChange={(e) => void set({ ai_pick: e.target.checked })} />
        <span>Let the model choose decorations for characters
          <small className="muted" style={{ display: "block" }}>Characters with none get a nameplate, background and wreath that suit them, picked once from the lists above. What you chose yourself is never changed. This uses your model (and your tokens, if it is a paid one).</small></span>
      </label>
      <div className="btnrow">
        <button className="btn" type="button" disabled={!!busy || missing.length === 0} onClick={() => void dressAll()}>Choose for the {missing.length} character{missing.length === 1 ? "" : "s"} without any now</button>
        {busy && <span className="tok" role="status">{busy}</span>}
      </div>
      {tagModal && <TagModal deco={deco} handle={handle} onClose={() => setTagModal(false)} onSave={async (p) => { await set(p); setTagModal(false); toast("Saved.", "ok"); }} />}
    </div>
  );
}

/** The name tag (2 to 4 letters, a colour and a symbol) and the banner behind your profile card. */
function TagModal({ deco, handle, onClose, onSave }: { deco: UserDeco; handle: string; onClose: () => void; onSave: (p: Partial<UserDeco>) => Promise<void> }) {
  const toast = useToast();
  const [d, setD] = useState({ tag: deco.tag, tag_color: deco.tag_color, tag_glyph: deco.tag_glyph, banner: deco.banner });
  const css = DecoCore.banner(d.banner)?.css ?? "";
  return (
    <Modal title="Name tag and banner" onClose={onClose}>
      <div className="srv-prev">
        <div className="srv-prev-banner" style={css ? { background: css } : undefined}><b>Your profile</b></div>
        <div className="srv-prev-me"><b>{handle} <TagChip tag={DecoCore.tagOk(d.tag) ? DecoCore.cleanTag(d.tag) : ""} color={d.tag_color} glyph={d.tag_glyph} /></b><small>{DecoCore.tagOk(d.tag) ? `Wearing the ${DecoCore.cleanTag(d.tag)} tag` : "No tag"}</small></div>
      </div>
      <TagFields value={d} onChange={(p) => setD({ ...d, ...p })} />
      <h4>Banner</h4>
      <div className="deco-row" role="group" aria-label="Banner">
        {[{ id: "", name: "None", css: "" }, ...DecoCore.BANNERS].map((b) => <button key={b.id || "none"} className="bn-pick" type="button" aria-label={b.name} title={b.name} aria-pressed={d.banner === b.id} style={b.css ? { background: b.css } : undefined} onClick={() => setD({ ...d, banner: b.id })}>{b.id ? "" : "None"}</button>)}
      </div>
      <p className="fine">The banner shows on your profile card when no moving background is chosen. Your tag sits beside your name.</p>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" type="button" onClick={() => { if (d.tag && !DecoCore.tagOk(d.tag)) { toast("A tag is 2 to 4 letters or numbers.", "err"); return; } void onSave({ ...d, tag: DecoCore.tagOk(d.tag) ? DecoCore.cleanTag(d.tag) : "" }); }}>Save</button>
        <button className="btn" type="button" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

/** A tag (2 to 4 letters or numbers), its colour and its symbol. Used for the name tag and for a room's tag. */
export function TagFields({ value, onChange }: { value: { tag: string; tag_color: string; tag_glyph: string }; onChange: (p: Partial<{ tag: string; tag_color: string; tag_glyph: string }>) => void }) {
  const d = value;
  return (
    <>
      <label className="field"><span>Name tag (2 to 4 letters or numbers)</span>
        <input value={d.tag} maxLength={4} placeholder="e.g. KOI" aria-label="Name tag" autoComplete="off" spellCheck={false} onChange={(e) => onChange({ tag: DecoCore.cleanTag(e.target.value) })} /></label>
      <div className="deco-row" role="group" aria-label="Tag colour">{DecoCore.TAG_COLORS.map(([c, n]) => <button key={c} className="ck-swatch" type="button" style={{ background: c }} aria-label={n} title={n} aria-pressed={d.tag_color === c} onClick={() => onChange({ tag_color: c })} />)}</div>
      <div className="deco-row" role="group" aria-label="Tag symbol">{DecoCore.TAG_GLYPHS.map(([g, n]) => <button key={n} className="btn glyph" type="button" aria-label={n} title={n} aria-pressed={d.tag_glyph === g} onClick={() => onChange({ tag_glyph: g })}>{g || "—"}</button>)}</div>
    </>
  );
}
