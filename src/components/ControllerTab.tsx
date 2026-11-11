import { useEffect, useRef, useState } from "react";
import { ACTIONS, KIND_NAME, activePad, buttonName, getBindings, isStandard, padKind, resetBindings, setBindings, type Bindings } from "../lib/gamepad";

/**
 * Settings → Controller: which controller is connected, what each hand gesture is bound to (shown with that controller's own
 * button names: A / Cross / B), and a way to rebind them. Works for Xbox, PlayStation, Nintendo, Steam Controller / Steam Deck
 * and any other pad the system reports, because buttons are numbered by position.
 */
export function ControllerTab() {
  const [pads, setPads] = useState<{ id: string; kind: ReturnType<typeof padKind>; standard: boolean; down: number[]; index: number }[]>([]);
  const [bind, setBind] = useState<Bindings>(getBindings);
  const [capture, setCapture] = useState<{ key: keyof Bindings; slot: number } | null>(null);
  const capRef = useRef(capture); capRef.current = capture;
  const bindRef = useRef(bind); bindRef.current = bind;
  const prev = useRef<number[]>([]);

  useEffect(() => {
    const t = window.setInterval(() => {
      const all = (navigator.getGamepads?.() ?? []).filter((g): g is Gamepad => !!g && g.connected);
      setPads(all.map((g) => ({ id: g.id, index: g.index, kind: padKind(g.id), standard: isStandard(g), down: g.buttons.map((b, i) => (b.pressed || b.value > 0.5 ? i : -1)).filter((i) => i >= 0) })));
      const a = activePad();
      const down = a ? a.buttons.map((b, i) => (b.pressed || b.value > 0.5 ? i : -1)).filter((i) => i >= 0) : [];
      const c = capRef.current;
      if (c) {
        const fresh = down.find((i) => !prev.current.includes(i));
        if (fresh !== undefined) {
          const cur = [...bindRef.current[c.key]];
          cur[c.slot] = fresh;
          const next = { ...bindRef.current, [c.key]: cur.filter((n, i, arr) => n !== undefined && arr.indexOf(n) === i) };
          setBindings(next); setBind(next); setCapture(null);
        }
      }
      prev.current = down;
    }, 80);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (!capture) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setCapture(null); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [capture]);

  const main = pads[0];
  const kind = main?.kind ?? "xbox";
  const remove = (key: keyof Bindings, slot: number) => { const next = { ...bind, [key]: bind[key].filter((_, i) => i !== slot) }; if (!next[key].length) return; setBindings(next); setBind(next); };

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Controller</h3>
        <p className="sub" style={{ margin: "4px 0 10px" }}>
          Use a controller to reach into the 3D room: pet, poke, tickle and pick her up. Xbox, PlayStation (DualShock 4 and DualSense), Nintendo (Switch Pro and Joy-Con),
          Steam Controller and Steam Deck (through Steam Input) and most other pads work with the same buttons: they are placed by position, and named the way your pad names them.
        </p>
        {main ? (
          <div className="row" style={{ gap: 10 }} data-testid="pad-info">
            <span aria-hidden style={{ fontSize: "1.4rem" }}>🎮</span>
            <div className="grow">
              <b>{KIND_NAME[main.kind]} controller</b> <span className="hint">· {main.id.slice(0, 70)}</span>
              {!main.standard && <div className="hint" style={{ color: "var(--danger)" }}>This pad doesn't report the standard layout, so its buttons are shown as numbers. Switching it to Xbox mode (or using Steam Input) usually fixes that; you can also rebind below.</div>}
            </div>
            <span className="hint" data-testid="pad-down">{main.down.length ? `Pressing: ${main.down.map((i) => buttonName(main.kind, i)).join(", ")}` : "Press a button to test"}</span>
          </div>
        ) : (
          <div className="hint" data-testid="pad-none">No controller found. Plug one in or turn it on, then press any button (browsers hide a pad until you do). On Steam, add the app as a non-Steam game, or turn on Steam Input for desktop.</div>
        )}
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Gestures and buttons</h3>
        <div style={{ display: "grid", gap: 10 }}>
          {ACTIONS.map((a) => (
            <div className="row" key={a.key} style={{ gap: 8, alignItems: "center" }} data-action={a.key}>
              <div className="grow" style={{ minWidth: 220 }}><b>{a.label}</b><div className="hint">{a.help}</div></div>
              {bind[a.key].map((n, slot) => (
                <span key={slot} className="chip on" style={{ gap: 6 }} data-btn={n}>
                  {buttonName(kind, n)}
                  <button className="linklike" aria-label={`Change ${a.label} button ${slot + 1}`} onClick={() => setCapture({ key: a.key, slot })} title="Change">✎</button>
                  {bind[a.key].length > 1 && <button className="linklike" aria-label={`Remove ${buttonName(kind, n)} from ${a.label}`} onClick={() => remove(a.key, slot)} title="Remove">✕</button>}
                </span>
              ))}
              {bind[a.key].length < 3 && <button className="btn sm" onClick={() => setCapture({ key: a.key, slot: bind[a.key].length })}>＋ Add button</button>}
              {capture?.key === a.key && <span className="hint" role="status" data-testid="pad-capture">Press a button on your controller… (Esc to cancel)</span>}
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" onClick={() => { resetBindings(); setBind(getBindings()); setCapture(null); }}>Reset to defaults</button>
          <span className="hint">Fixed: sticks move the hands, triggers reach in, bumpers pull back (and the scroll wheel pushes a carried character in or out).</span>
        </div>
      </div>
    </div>
  );
}
