import { useEffect, useState } from "react";
import { api, newProfile, profileAvatar, onModelProgress, saveExportFile, type ApiProfile, type EngineStatus, type ExportInfo, type Hardware, type ModelFile, type ModelProgress, type Settings } from "../api";
import { CreateProfileModal, PASSCODE_NOTE, ProfileAvatar } from "../components/ProfileForms";
import { PersonasTab, ProfilePicture } from "../components/Personas";
import { ControllerTab } from "../components/ControllerTab";
import { Modal, useToast } from "../components/ui";
import { errText, fmtBytes } from "../lib/util";
import type { SessionState } from "../api";
import { useStore } from "../store";

type Tab = "profile" | "personas" | "models" | "chat" | "voice" | "controller" | "look" | "privacy" | "about";
const TABS: [Tab, string][] = [["profile", "Profile"], ["personas", "Personas"], ["models", "Models"], ["chat", "Chat"], ["voice", "Voice"], ["controller", "Controller"], ["look", "Appearance"], ["privacy", "Privacy"], ["about", "About"]];

const ENDPOINTS: [string, string, string][] = [
  ["OpenAI", "https://api.openai.com/v1", "gpt-4o-mini"],
  ["OpenRouter", "https://openrouter.ai/api/v1", "meta-llama/llama-3.3-70b-instruct"],
  ["Ollama (this PC or LAN)", "http://localhost:11434/v1", "llama3.2"],
  ["LM Studio", "http://localhost:1234/v1", "local-model"],
];

export default function SettingsPage({ initialTab }: { initialTab?: string }) {
  const { settings, setSettings, refresh } = useStore();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>((TABS.find((t) => t[0] === initialTab)?.[0]) ?? "models");
  const [s, setS] = useState<Settings>(settings);
  // the name can also change from the Profile tab's own Save; keep this draft in step so it can't revert it
  useEffect(() => { setS((x) => (x.user_name === settings.user_name ? x : { ...x, user_name: settings.user_name })); }, [settings.user_name]);
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  const patch = (p: Partial<Settings>) => setS((x) => ({ ...x, ...p }));

  const save = async () => {
    try { await setSettings(s); toast("Settings saved", "ok"); } catch (e) { toast(errText(e), "err"); }
  };

  return (
    <div className="page" style={{ maxWidth: 880 }}>
      <div className="page-head">
        <div><h1>Settings</h1></div>
        <div className="row">
          {dirty && <span className="tok">Unsaved changes</span>}
          <button className="btn primary" disabled={!dirty} onClick={save}>Save settings</button>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "profile" && <ProfileTab s={s} patch={patch} />}
      {tab === "personas" && <PersonasTab />}
      {tab === "models" && <Models s={s} patch={patch} onChanged={refresh} />}
      {tab === "chat" && <ChatTab s={s} patch={patch} />}
      {tab === "controller" && <ControllerTab />}
      {tab === "voice" && <VoiceTab s={s} patch={patch} ensureSaved={async () => { if (dirty) await setSettings(s); }} />}
      {tab === "look" && <Look s={s} patch={patch} />}
      {tab === "privacy" && <Privacy s={s} />}
      {tab === "about" && <About />}
    </div>
  );
}

function Models({ s, patch, onChanged }: { s: Settings; patch: (p: Partial<Settings>) => void; onChanged: () => void }) {
  const toast = useToast();
  const { info } = useStore();
  const [hw, setHw] = useState<Hardware | null>(null);
  const [models, setModels] = useState<ModelFile[]>([]);
  const [prog, setProg] = useState<Record<string, ModelProgress>>({});
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [custom, setCustom] = useState({ url: "", file: "" });
  const [keyDraft, setKeyDraft] = useState("");
  const [keyPresent, setKeyPresent] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState(false);

  const reload = async () => {
    setModels(await api.listModels());
    api.engineStatus().then(setEngine).catch(() => {});
    onChanged();
  };
  useEffect(() => {
    api.hardware().then(setHw);
    reload();
    (["openai", "anthropic"] as const).forEach((p) => api.hasApiKey(p).then((r) => setKeyPresent((k) => ({ ...k, [p]: r.present }))));
    const sub = onModelProgress((e) => {
      setProg((p) => ({ ...p, [e.file]: e }));
      if (e.done) { if (e.error) toast(`Download failed: ${e.error}`, "err"); else toast(`${e.file} is ready`, "ok"); reload(); }
    });
    return () => { sub.then((u) => u()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const download = async (url: string, file: string) => {
    setProg((p) => ({ ...p, [file]: { file, downloaded: 0, total: 0, done: false, error: null } }));
    try {
      await api.downloadModel(url, file);
      if (!s.local_model) patch({ local_model: file });
    } catch { /* surfaced through the progress event */ }
  };

  const provider = s.provider;
  const isCustom = provider.startsWith("custom:");
  const key = provider === "anthropic" ? "anthropic" : "openai";
  const saveKey = async () => {
    try {
      const where = await api.setApiKey(key, keyDraft);
      setKeyDraft("");
      setKeyPresent((k) => ({ ...k, [key]: where !== "none" }));
      toast(where === "keychain" ? "Key saved in your system keychain" : where === "file" ? "Key saved in a private file in the app folder (no keychain was available)" : "Key removed", "ok");
    } catch (e) { toast(errText(e), "err"); }
  };
  const test = async () => {
    setTesting(true);
    try {
      toast(`Connected. The model says: "${await api.testProvider()}"`, "ok");
    } catch (e) { toast(errText(e), "err"); } finally { setTesting(false); }
  };
  const insecure = provider === "openai" && s.openai_base_url.startsWith("http://") && !/^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(s.openai_base_url);

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div className="card">
        <h3>Where do replies come from?</h3>
        <div className="row" style={{ marginTop: 10 }}>
          {([["local", "🖥️ Built-in (on this device)"], ["openai", "☁️ OpenAI-compatible"], ["anthropic", "☁️ Anthropic"]] as const).map(([k, l]) => (
            <button key={k} className={`chip ${provider === k ? "on" : ""}`} style={{ padding: "6px 14px", fontSize: ".9rem" }} onClick={() => patch({ provider: k })}>{l}</button>
          ))}
          <button className={`chip ${isCustom ? "on" : ""}`} style={{ padding: "6px 14px", fontSize: ".9rem" }}
            onClick={() => {
              if (isCustom) return;
              if (s.profiles.length) patch({ provider: `custom:${s.profiles[0].id}` });
              else { const np = newProfile(); patch({ profiles: [np], provider: `custom:${np.id}` }); }
            }}>🔌 Other API{s.profiles.length ? ` (${s.profiles.length})` : ""}</button>
        </div>
        <p className="hint">
          {provider === "local" ? "Runs entirely on your computer. Nothing leaves it." : "Your messages are sent to that provider over an encrypted HTTPS connection, using your own API key (http:// addresses on your own network are also fine)."}
        </p>
      </div>

      {provider === "local" && (
        <div className="card">
          <h3>Models on this device</h3>
          {info && !info.local_engine ? (
            <p className="hint">The built-in engine isn't available on {info.platform} yet. Use a cloud provider, or point "OpenAI-compatible" at a model server on your home network (Ollama, LM Studio, or this app running on your PC).</p>
          ) : (
            <>
              {hw && <p className="hint">This computer has about {hw.total_ram_gb.toFixed(0)} GB of memory. The ★ pick should run comfortably.</p>}
              {hw?.presets.map((p) => {
                const have = models.some((m) => m.file === p.file);
                const pr = prog[p.file];
                const active = pr && !pr.done;
                const pct = pr && pr.total ? Math.min(100, (pr.downloaded / pr.total) * 100) : 0;
                return (
                  <div className="preset" key={p.id}>
                    <div>
                      <b>{p.label}</b> {hw.recommended === p.id && <span className="chip on">★ recommended</span>} <span className="tok">{p.size_gb} GB</span>
                      <div className="hint">{p.blurb}</div>
                      {active && <div className="bar" style={{ marginTop: 6 }}><div style={{ width: `${pct}%` }} /></div>}
                      {active && <div className="tok">{fmtBytes(pr.downloaded)}{pr.total ? ` of ${fmtBytes(pr.total)}` : ""}</div>}
                    </div>
                    <div className="row">
                      {have ? <span className="chip">Installed</span>
                        : active ? <button className="btn sm" onClick={() => api.cancelDownload(p.file)}>Cancel</button>
                        : <button className="btn primary sm" onClick={() => download(p.url, p.file)}>Download</button>}
                    </div>
                  </div>
                );
              })}
              <h3 style={{ marginTop: 20 }}>Your model files</h3>
              {models.length === 0 && <p className="hint">None yet. Download one above, or add your own below.</p>}
              {models.map((m) => (
                <div className="preset" key={m.file}>
                  <div><b>{m.file}</b> <span className="tok">{fmtBytes(m.size)}</span></div>
                  <div className="row">
                    {s.local_model === m.file ? <span className="chip on">In use</span> : <button className="btn sm" onClick={() => patch({ local_model: m.file })}>Use this</button>}
                    <button className="btn danger sm" onClick={async () => {
                      if (!window.confirm(`Delete ${m.file}?`)) return;
                      try { await api.deleteModel(m.file); if (s.local_model === m.file) patch({ local_model: "" }); reload(); } catch (e) { toast(errText(e), "err"); }
                    }}>Delete</button>
                  </div>
                </div>
              ))}
              <h3 style={{ marginTop: 20 }}>Add any GGUF model</h3>
              <p className="hint">Paste a direct https link to a .gguf file (for example from Hugging Face). Or drop a file into the models folder inside the app data folder (see About).</p>
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <input type="text" placeholder="https://huggingface.co/…/resolve/main/model.Q4_K_M.gguf" value={custom.url}
                  onChange={(e) => { const url = e.target.value; setCustom({ url, file: custom.file || decodeURIComponent(url.split("?")[0].split("/").pop() ?? "") }); }} />
                <input type="text" style={{ maxWidth: 260 }} placeholder="file name.gguf" value={custom.file} onChange={(e) => setCustom({ ...custom, file: e.target.value })} />
                <button className="btn" disabled={!custom.url.startsWith("https://") || !custom.file.toLowerCase().endsWith(".gguf")} onClick={() => download(custom.url, custom.file)}>Download</button>
              </div>
              <div className="row" style={{ marginTop: 16 }}>
                <label className="row"><input type="checkbox" checked={s.local_gpu} onChange={(e) => patch({ local_gpu: e.target.checked })} /> Use the graphics card when possible (Vulkan)</label>
                <div className="grow" />
                <span className="tok">Engine: {engine?.running ? `running · ${engine.backend}` : "idle (starts when you chat)"}</span>
                {engine?.running && <button className="btn sm" onClick={async () => { await api.stopEngine(); reload(); }}>Stop engine</button>}
              </div>
            </>
          )}
        </div>
      )}

      {isCustom && <OtherApi s={s} patch={patch} />}

      {(provider === "openai" || provider === "anthropic") && (
        <div className="card">
          <h3>{provider === "anthropic" ? "Anthropic" : "OpenAI-compatible server"}</h3>
          {provider === "openai" && (
            <>
              <div className="chips" style={{ margin: "8px 0 12px" }}>
                {ENDPOINTS.map(([n, u, m]) => <button key={n} className="chip" onClick={() => patch({ openai_base_url: u, openai_model: m })}>{n}</button>)}
              </div>
              <label className="f"><span>Base URL:</span><span><input type="text" value={s.openai_base_url} onChange={(e) => patch({ openai_base_url: e.target.value })} />
                {insecure && <div className="hint" style={{ color: "var(--danger)" }}>This address isn't encrypted (http://) and isn't on your local network. Use https:// so nobody can read your chats in transit.</div>}</span></label>
              <label className="f"><span>Model:</span><input type="text" value={s.openai_model} onChange={(e) => patch({ openai_model: e.target.value })} /></label>
            </>
          )}
          {provider === "anthropic" && (
            <label className="f"><span>Model:</span><input type="text" value={s.anthropic_model} onChange={(e) => patch({ anthropic_model: e.target.value })} /></label>
          )}
          <label className="f"><span>API key:</span>
            <span>
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <input type="password" autoComplete="off" placeholder={keyPresent[key] ? "A key is saved (type to replace)" : provider === "openai" ? "Optional for local servers" : "sk-ant-…"} value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} />
                <button className="btn" disabled={!keyDraft && !keyPresent[key]} onClick={saveKey}>{keyDraft ? "Save key" : "Remove key"}</button>
              </div>
              <div className="hint">Stored in your system keychain when one is available, otherwise in a private file in the app folder. It's never shown again or sent anywhere except the provider above.</div>
            </span>
          </label>
          <button className="btn" onClick={test} disabled={testing}>{testing ? "Testing…" : "Test connection"}</button>
          <span className="hint"> Save settings first so the test uses them.</span>
        </div>
      )}
    </div>
  );
}

function ChatTab({ s, patch }: { s: Settings; patch: (p: Partial<Settings>) => void }) {
  return (
    <div className="card">
      <label className="f"><span>Context size:</span><span><input type="number" min={512} step={512} value={s.context_tokens} onChange={(e) => patch({ context_tokens: Number(e.target.value) })} /><div className="hint">How much of the chat the model can see (tokens). Bigger remembers more but uses more memory. 4096 is a safe start.</div></span></label>
      <label className="f"><span>Max reply length:</span><input type="number" min={16} step={16} value={s.max_tokens} onChange={(e) => patch({ max_tokens: Number(e.target.value) })} /></label>
      <label className="f"><span>Creativity ({s.temperature.toFixed(2)}):</span><input type="range" min={0} max={2} step={0.05} value={s.temperature} onChange={(e) => patch({ temperature: Number(e.target.value) })} /></label>
      <label className="f"><span>Top-p ({s.top_p.toFixed(2)}):</span><input type="range" min={0.1} max={1} step={0.05} value={s.top_p} onChange={(e) => patch({ top_p: Number(e.target.value) })} /></label>
      <label className="f"><span>Default system prompt:</span><span><textarea value={s.default_system} placeholder="Leave empty for the built-in roleplay prompt." onChange={(e) => patch({ default_system: e.target.value })} /><div className="hint">Use {"{{char}}"} and {"{{user}}"}.</div></span></label>
      <label className="f"><span>Character prompts:</span><label className="row"><input type="checkbox" checked={s.use_card_system_prompt} onChange={(e) => patch({ use_card_system_prompt: e.target.checked })} /> Use each card's own system prompt and post-history instructions</label></label>
    </div>
  );
}

const VOICE_PRESETS: [string, string, string, string][] = [
  ["OpenAI", "https://api.openai.com/v1", "whisper-1", "Cloud: needs an OpenAI API key"],
  ["Groq", "https://api.groq.com/openai/v1", "whisper-large-v3-turbo", "Cloud: fast, has a free tier"],
  ["This computer", "http://127.0.0.1:8080/v1", "whisper-1", "Fully offline: run a local Whisper server (see below)"],
];

function VoiceTab({ s, patch, ensureSaved }: { s: Settings; patch: (p: Partial<Settings>) => void; ensureSaved: () => Promise<void> }) {
  const toast = useToast();
  const [keyDraft, setKeyDraft] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => { api.hasApiKey("stt").then((r) => setHasKey(r.present)).catch(() => {}); }, []);
  const insecure = s.stt_url.startsWith("http://") && !/^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(s.stt_url);
  const saveKey = async () => {
    try {
      const where = await api.setApiKey("stt", keyDraft);
      setKeyDraft(""); setHasKey(where !== "none");
      toast(where === "none" ? "Key removed" : "Key saved", "ok");
    } catch (e) { toast(errText(e), "err"); }
  };
  const test = async () => {
    setTesting(true);
    try { await ensureSaved(); toast(await api.testVoice(), "ok"); } catch (e) { toast(errText(e), "err"); } finally { setTesting(false); }
  };
  return (
    <div className="card">
      <h3>Voice input</h3>
      <p className="hint" style={{ margin: "6px 0 12px" }}>
        The <b>🎤 button</b> in a chat listens to you, turns your speech into text with the speech-to-text server below, and sends it, so the character
        can hear you and answer. Nothing is recorded unless you press the mic, and the recording is sent only to the server you pick here.
      </p>
      <div className="chips" style={{ margin: "0 0 12px" }}>
        {VOICE_PRESETS.map(([n, u, m, tip]) => <button key={n} className={`chip ${s.stt_url === u ? "on" : ""}`} title={tip} onClick={() => patch({ stt_url: u, stt_model: m })}>{n}</button>)}
      </div>
      <label className="f"><span>Server address:</span><span><input type="text" value={s.stt_url} onChange={(e) => patch({ stt_url: e.target.value })} aria-label="Voice server address" />
        {insecure && <div className="hint" style={{ color: "var(--danger)" }}>This address isn't encrypted (http://) and isn't on your local network. Use https:// so nobody can listen in.</div>}</span></label>
      <label className="f"><span>Model:</span><input type="text" value={s.stt_model} onChange={(e) => patch({ stt_model: e.target.value })} aria-label="Voice model" /></label>
      <label className="f"><span>Language:</span><span><input type="text" placeholder="Auto-detect" maxLength={8} value={s.stt_language} onChange={(e) => patch({ stt_language: e.target.value })} aria-label="Voice language" />
        <div className="hint">Optional: a code like en, es, ja. Leave empty to let the server work it out.</div></span></label>
      <label className="f"><span>API key:</span>
        <span>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input type="password" autoComplete="off" placeholder={hasKey ? "A key is saved (type to replace)" : "Optional for a server on your own computer"} value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} aria-label="Voice API key" />
            <button className="btn" disabled={!keyDraft && !hasKey} onClick={saveKey}>{keyDraft ? "Save key" : "Remove key"}</button>
          </div>
          <div className="hint">Stored the same way as your chat keys (system keychain when available), and sent only to the server above.</div>
        </span>
      </label>
      <label className="f"><span>After listening:</span><label className="row"><input type="checkbox" checked={s.stt_auto_send} onChange={(e) => patch({ stt_auto_send: e.target.checked })} /> Send what I said straight away (otherwise it goes into the message box so you can check it first)</label></label>
      <button className="btn" onClick={test} disabled={testing}>{testing ? "Testing…" : "Test connection"}</button>
      <span className="hint"> Uses the settings above (they are saved first).</span>
      <h3 style={{ marginTop: 18 }}>Fully offline voice</h3>
      <p className="hint" style={{ marginTop: 6 }}>
        Run any local server that offers <code>/v1/audio/transcriptions</code>, for example <b>whisper.cpp</b>'s <code>whisper-server</code>, then pick <i>This computer</i>
        and adjust the port. Your voice then never leaves your machine. For the best experience, pair voice with a fast model (a cloud API, or a local model that fits your hardware),
        since the reply starts only after the model has read what you said.
      </p>
    </div>
  );
}

function Look({ s, patch }: { s: Settings; patch: (p: Partial<Settings>) => void }) {
  return (
    <div className="card">
      <h3>Theme</h3>
      <div className="row" style={{ marginTop: 10 }}>
        {[["dusk", "Dusk"], ["midnight", "Midnight"], ["paper", "Paper (light)"]].map(([k, l]) => (
          <button key={k} className={`chip ${s.theme === k ? "on" : ""}`} style={{ padding: "6px 14px", fontSize: ".9rem" }} onClick={() => { patch({ theme: k }); document.documentElement.dataset.theme = k; }}>{l}</button>
        ))}
      </div>
    </div>
  );
}

const PRESETS: [string, Partial<ApiProfile>][] = [
  ["OpenRouter", { base_url: "https://openrouter.ai/api/v1", format: "openai" }],
  ["Groq", { base_url: "https://api.groq.com/openai/v1", format: "openai" }],
  ["Together", { base_url: "https://api.together.xyz/v1", format: "openai" }],
  ["Mistral", { base_url: "https://api.mistral.ai/v1", format: "openai" }],
  ["DeepSeek", { base_url: "https://api.deepseek.com/v1", format: "openai" }],
  ["xAI", { base_url: "https://api.x.ai/v1", format: "openai" }],
  ["Ollama / LM Studio (this network)", { base_url: "http://localhost:11434/v1", format: "openai", auth: "none" }],
  ["Anthropic-style", { base_url: "https://api.anthropic.com", format: "anthropic" }],
];

/** Saved profiles for any API that speaks the OpenAI chat or Anthropic messages format. */
function OtherApi({ s, patch }: { s: Settings; patch: (p: Partial<Settings>) => void }) {
  const toast = useToast();
  const selId = s.provider.slice("custom:".length);
  const prof = s.profiles.find((p) => p.id === selId) ?? s.profiles[0];
  const [keyDraft, setKeyDraft] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<"" | "test" | "models">("");

  useEffect(() => {
    setKeyDraft(""); setModels([]);
    if (prof) api.hasApiKey(`custom-${prof.id}`).then((r) => setHasKey(r.present)).catch(() => setHasKey(false));
  }, [prof?.id]);

  if (!prof) return null;
  const upd = (p: Partial<ApiProfile>) => patch({ profiles: s.profiles.map((x) => (x.id === prof.id ? { ...x, ...p } : x)) });
  const insecure = prof.base_url.startsWith("http://") && !/^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^/.:]+(:|\/|$))/.test(prof.base_url);
  const badJson = prof.extra_body.trim() !== "" && (() => { try { const v = JSON.parse(prof.extra_body); return typeof v !== "object" || Array.isArray(v) || v === null; } catch { return true; } })();

  const saveKey = async () => {
    try {
      const where = await api.setApiKey(`custom-${prof.id}`, keyDraft);
      setKeyDraft(""); setHasKey(where !== "none");
      toast(where === "keychain" ? "Key saved in your system keychain" : where === "file" ? "Key saved in a private file in the app folder (no keychain was available)" : "Key removed", "ok");
    } catch (e) { toast(errText(e), "err"); }
  };
  const fetchModels = async () => {
    setBusy("models");
    try {
      const m = await api.listRemoteModels(prof);
      setModels(m);
      toast(m.length ? `Found ${m.length} models` : "Connected, but the server didn't list any models. Type the name yourself.", m.length ? "ok" : "info");
    } catch (e) { toast(errText(e), "err"); } finally { setBusy(""); }
  };
  const test = async () => {
    setBusy("test");
    try { toast(`Connected. The model says: "${await api.testProfile(prof)}"`, "ok"); }
    catch (e) { toast(errText(e), "err"); } finally { setBusy(""); }
  };
  const remove = async () => {
    if (!window.confirm(`Remove "${prof.name}"? Its saved key is deleted too.`)) return;
    await api.setApiKey(`custom-${prof.id}`, "").catch(() => {});
    const rest = s.profiles.filter((x) => x.id !== prof.id);
    patch({ profiles: rest, provider: rest.length ? `custom:${rest[0].id}` : "local" });
  };

  return (
    <div className="card">
      <h3>Other API</h3>
      <p className="hint">Connect any service or server that uses the OpenAI chat format (most of them) or Anthropic's. Copy the base URL and model name from the provider's docs. You can save several and switch between them.</p>
      <div className="chips" style={{ margin: "10px 0 14px" }}>
        {s.profiles.map((p) => (
          <button key={p.id} className={`chip ${p.id === prof.id ? "on" : ""}`} onClick={() => patch({ provider: `custom:${p.id}` })}>{p.name || "Unnamed"}</button>
        ))}
        <button className="chip" onClick={() => { const np = newProfile(); np.name = `API ${s.profiles.length + 1}`; patch({ profiles: [...s.profiles, np], provider: `custom:${np.id}` }); }}>＋ Add another</button>
      </div>

      <label className="f"><span>Quick fill:</span>
        <span className="chips">{PRESETS.map(([n, p]) => <button key={n} className="chip" onClick={() => upd({ ...p, name: prof.name === "My API" || /^API \d+$/.test(prof.name) ? n : prof.name })}>{n}</button>)}</span>
      </label>
      <label className="f"><span>Name:</span><input type="text" value={prof.name} onChange={(e) => upd({ name: e.target.value })} /></label>
      <label className="f"><span>Format:</span>
        <span>
          <select value={prof.format} onChange={(e) => upd({ format: e.target.value as ApiProfile["format"] })}>
            <option value="openai">OpenAI-style (chat completions): works with most services</option>
            <option value="anthropic">Anthropic-style (messages)</option>
          </select>
        </span>
      </label>
      <label className="f"><span>Base URL:</span>
        <span>
          <input type="text" placeholder="https://api.example.com/v1" value={prof.base_url} onChange={(e) => upd({ base_url: e.target.value.trim() })} />
          {insecure && <div className="hint" style={{ color: "var(--danger)" }}>This address isn't encrypted (http://) and isn't on your local network. Use https:// so nobody can read your chats in transit.</div>}
        </span>
      </label>
      <label className="f"><span>Model:</span>
        <span>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input type="text" list="other-api-models" placeholder="model name" value={prof.model} onChange={(e) => upd({ model: e.target.value })} />
            <button className="btn" disabled={!prof.base_url || busy !== ""} onClick={fetchModels}>{busy === "models" ? "Asking…" : "Fetch list"}</button>
          </div>
          <datalist id="other-api-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
          {models.length > 0 && <div className="hint">{models.length} models available. Start typing to pick one.</div>}
        </span>
      </label>
      <label className="f"><span>API key:</span>
        <span>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input type="password" autoComplete="off" placeholder={hasKey ? "A key is saved (type to replace)" : "Paste your key (optional for local servers)"} value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} />
            <button className="btn" disabled={!keyDraft && !hasKey} onClick={saveKey}>{keyDraft ? "Save key" : "Remove key"}</button>
          </div>
          <div className="hint">Stored in your system keychain when one is available, otherwise in a private file in the app folder.</div>
        </span>
      </label>

      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Advanced (for unusual APIs)</summary>
        {prof.format === "openai" && (
          <>
            <label className="f"><span>Chat path:</span><span><input type="text" value={prof.chat_path} onChange={(e) => upd({ chat_path: e.target.value })} /><div className="hint">Added to the base URL. Almost always /chat/completions.</div></span></label>
            <label className="f"><span>Key is sent as:</span>
              <span>
                <select value={prof.auth} onChange={(e) => upd({ auth: e.target.value as ApiProfile["auth"] })}>
                  <option value="bearer">Authorization: Bearer … (most common)</option>
                  <option value="x-api-key">x-api-key header</option>
                  <option value="header">A header name I choose</option>
                  <option value="none">Not sent (no key needed)</option>
                </select>
                {prof.auth === "header" && <input type="text" style={{ marginTop: 8 }} placeholder="Header name, e.g. X-API-Token" value={prof.auth_header} onChange={(e) => upd({ auth_header: e.target.value })} />}
              </span>
            </label>
          </>
        )}
        <label className="f"><span>Extra headers:</span>
          <span style={{ display: "grid", gap: 6 }}>
            {prof.headers.map((h, i) => (
              <div className="row" key={i} style={{ flexWrap: "nowrap" }}>
                <input type="text" placeholder="Name" value={h.name} onChange={(e) => upd({ headers: prof.headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                <input type="text" placeholder="Value" value={h.value} onChange={(e) => upd({ headers: prof.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                <button className="btn danger sm" onClick={() => upd({ headers: prof.headers.filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
            <button className="btn sm" style={{ justifySelf: "start" }} onClick={() => upd({ headers: [...prof.headers, { name: "", value: "" }] })}>＋ Add header</button>
            <div className="hint">Sent with every request. Saved in your settings (not the keychain), so don't put secrets here; use the key field.</div>
          </span>
        </label>
        <label className="f"><span>Extra JSON:</span>
          <span>
            <textarea style={{ minHeight: 70, fontFamily: "monospace" }} placeholder={'{"provider": {"order": ["x"]}}'} value={prof.extra_body} onChange={(e) => upd({ extra_body: e.target.value })} />
            <div className="hint" style={badJson ? { color: "var(--danger)" } : undefined}>{badJson ? "This must be a JSON object, like {\"key\": \"value\"}." : "Merged into every request body, for provider-specific options. Can override temperature, max_tokens, etc."}</div>
          </span>
        </label>
      </details>

      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn" onClick={test} disabled={busy !== "" || !prof.base_url || !prof.model || badJson}>{busy === "test" ? "Testing…" : "Test connection"}</button>
        <span className="hint grow">Uses the key you've saved above.</span>
        <button className="btn danger" onClick={remove}>Remove this API</button>
      </div>
    </div>
  );
}

function Privacy({ s }: { s: Settings }) {
  const custom = s.profiles.find((p) => `custom:${p.id}` === s.provider);
  return (
    <div className="card" style={{ display: "grid", gap: 10 }}>
      <h3>What stays on your device</h3>
      <p>Your characters, chats, images, videos, VRM models, and settings are stored only in the app's data folder. Profiles are local to this device: there is no online account, no sync, and no analytics.</p>
      <h3>Profiles and passcodes</h3>
      <p>Each profile has its own characters, chats, settings and API keys, and guest mode keeps its own separate space. A passcode keeps other people on this computer out of your profile inside the app. It does <b>not</b> encrypt files on disk, so anyone with access to your user account on this computer could still read the data folder. Eject and backup files are not encrypted either, and never contain API keys or passcodes.</p>
      <h3>When you use the built-in model</h3>
      <p>Nothing leaves your computer. The engine only listens on your own machine (127.0.0.1).</p>
      <h3>When you use a cloud provider</h3>
      <p>Each message and the character context needed to answer it are sent to the provider you picked, over an encrypted HTTPS (TLS) connection, so your internet provider, mobile carrier, or Wi-Fi network can see that you connected to that service but not what you said. The provider itself does receive your text, so check its privacy policy.</p>
      <p>Right now you're using: <b>{s.provider === "local" ? "the built-in model (fully offline)" : s.provider === "anthropic" ? "Anthropic (cloud)" : custom ? `${custom.name} (${custom.base_url || "no address yet"})` : `${s.openai_base_url}`}</b>.</p>
      <h3>Model downloads</h3>
      <p>The only other network use is downloading model files when you ask for them.</p>
    </div>
  );
}

function About() {
  const { info } = useStore();
  return (
    <div className="card">
      <div className="kv">
        <span>Version</span><b>{info?.version}</b>
        <span>Platform</span><b>{info?.platform}{info?.portable ? " (portable)" : ""}</b>
        <span>Data folder</span><b>{info?.data_dir}</b>
        <span>Built-in engine</span><b>{info?.local_engine ? "llama.cpp (bundled)" : "not available on this platform"}</b>
      </div>
      <p className="hint" style={{ marginTop: 14 }}>
        To back up or move everything, copy the data folder. {info?.portable ? "In the portable build it sits right next to the program, so copying that folder moves your whole setup." : ""}
      </p>
    </div>
  );
}

function plural(n: number, w: string) { return `${n} ${w}${n === 1 ? "" : "s"}`; }
const summary = (i: ExportInfo) => `${plural(i.characters, "character")}, ${plural(i.chats, "chat")}, ${plural(i.messages, "message")}, ${plural(i.media, "media file")} (${fmtBytes(i.size)})`;

function ProfileTab({ s, patch }: { s: Settings; patch: (p: Partial<Settings>) => void }) {
  const { session, setSession, refresh } = useStore();
  const toast = useToast();
  const p = session.profile;
  const [name, setName] = useState(p?.display_name ?? "");
  const [pc, setPc] = useState({ current: "", next: "", again: "" });
  const [modal, setModal] = useState<null | "claim" | "export" | "eject" | "delete">(null);

  useEffect(() => setName(p?.display_name ?? ""), [p?.display_name]);

  const saveName = async () => {
    try { setSession(await api.updateProfile(name)); await refresh(); toast("Name saved", "ok"); } catch (e) { toast(errText(e), "err"); }
  };
  const savePasscode = async (remove?: boolean) => {
    if (!remove && pc.next !== pc.again) return toast("The two new passcodes don't match.", "err");
    try {
      setSession(await api.setPasscode(pc.current, remove ? "" : pc.next));
      setPc({ current: "", next: "", again: "" });
      toast(remove ? "Passcode removed" : "Passcode saved", "ok");
    } catch (e) { toast(errText(e), "err"); }
  };
  const signOut = async () => { try { setSession(await api.signOut()); } catch (e) { toast(errText(e), "err"); } };

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div className="card">
        <div className="row" style={{ gap: 14 }}>
          <ProfileAvatar name={p?.handle ?? "Guest"} size={64} src={profileAvatar(p)} frame={p?.avatar_frame} />
          <div className="grow" style={{ minWidth: 200 }}>
            <h3>{p ? p.handle : "Guest"}</h3>
            <ProfilePicture />
            <div className="hint">{p ? "A profile on this device. Its characters, chats and keys are separate from every other profile." : "Guest space. Nothing here is tied to a profile."}</div>
          </div>
          <button className="btn" onClick={signOut}>Switch profile</button>
        </div>
        {!p && (
          <div className="banner" style={{ marginTop: 14, marginBottom: 0 }}>
            <span style={{ fontSize: "1.3rem" }}>🔖</span>
            <div className="grow">Want your chats tied to a name, with an optional passcode? Make the guest space a real profile. Everything moves over.</div>
            <button className="btn primary sm" onClick={() => setModal("claim")}>Make this a real profile</button>
          </div>
        )}
      </div>

      <div className="card">
        <h3>How you appear in chats</h3>
        {p ? (
          <label className="f"><span>Your name:</span>
            <span className="row" style={{ flexWrap: "nowrap" }}>
              <input type="text" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn" disabled={!name.trim() || name.trim() === p.display_name} onClick={saveName}>Save name</button>
            </span>
          </label>
        ) : (
          <label className="f"><span>Your name:</span><input type="text" value={s.user_name} onChange={(e) => patch({ user_name: e.target.value })} /></label>
        )}
        <label className="f"><span>About you:</span><span><textarea value={s.user_description} placeholder="Optional. Who you are, for characters to know." onChange={(e) => patch({ user_description: e.target.value })} /><div className="hint">Saved with the Save settings button.</div></span></label>
      </div>

      {p && (
        <div className="card">
          <h3>Passcode</h3>
          <p className="hint">{PASSCODE_NOTE}</p>
          <div style={{ display: "grid", gap: 8, maxWidth: 420 }}>
            {p.has_passcode && <input type="password" autoComplete="current-password" placeholder="Current passcode" value={pc.current} onChange={(e) => setPc({ ...pc, current: e.target.value })} />}
            <input type="password" autoComplete="new-password" placeholder={p.has_passcode ? "New passcode" : "Choose a passcode (4+ characters)"} value={pc.next} onChange={(e) => setPc({ ...pc, next: e.target.value })} />
            <input type="password" autoComplete="new-password" placeholder="New passcode again" value={pc.again} onChange={(e) => setPc({ ...pc, again: e.target.value })} />
            <div className="row">
              <button className="btn primary" disabled={!pc.next} onClick={() => savePasscode()}>{p.has_passcode ? "Change passcode" : "Set passcode"}</button>
              {p.has_passcode && <button className="btn danger" disabled={!pc.current} onClick={() => savePasscode(true)}>Remove passcode</button>}
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h3>When the app starts</h3>
        <label className="row" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={session.ask_on_launch} onChange={async (e) => { try { setSession(await api.setLaunchPref(e.target.checked)); } catch (er) { toast(errText(er), "err"); } }} />
          Ask which profile to use every time (otherwise it reopens the last one, unless that one has a passcode)
        </label>
      </div>

      <div className="card">
        <h3>Your data</h3>
        <p className="hint">Everything in {p ? "this profile" : "the guest space"}: characters, dorms, chats and messages, their images, GIFs, videos and 3D models, and your settings. API keys and passcodes are never saved to a file.</p>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => setModal("export")}>Save a backup copy…</button>
          <button className="btn" onClick={() => setModal("eject")}>Eject {p ? "profile" : "guest data"}…</button>
          <button className="btn danger" onClick={() => setModal("delete")}>Delete {p ? "profile" : "guest data"}…</button>
        </div>
        <p className="hint" style={{ marginTop: 10 }}><b>Eject</b> saves everything to a file, then takes it off this device. It isn't a delete: import the file from the profile screen, here or on another device, and it all comes back.</p>
      </div>

      {modal === "claim" && <CreateProfileModal claim onClose={() => setModal(null)} onDone={(st) => { setModal(null); setSession(st); }} />}
      {(modal === "export" || modal === "eject") && <ExportFlow eject={modal === "eject"} label={p ? p.handle : "guest data"} onClose={() => setModal(null)} onEjected={(st) => { setModal(null); setSession(st); }} />}
      {modal === "delete" && <DeleteFlow expected={p ? p.handle : "guest"} onClose={() => setModal(null)} onDeleted={(st) => { setModal(null); setSession(st); }} />}
    </div>
  );
}

/** Save a verified copy to a file; for Eject, then remove the profile once the user confirms they have it. */
function ExportFlow({ eject, label, onClose, onEjected }: { eject: boolean; label: string; onClose: () => void; onEjected: (s: SessionState) => void }) {
  const toast = useToast();
  const [info, setInfo] = useState<ExportInfo | null>(null);
  const [saved, setSaved] = useState<{ path: string; verified: boolean } | null>(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    setBusy(true); setErr("");
    try {
      const i = await api.prepareExport();
      setInfo(i);
      const r = await saveExportFile(i);
      if (r) setSaved(r);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!info) return;
    setBusy(true); setErr("");
    try { const st = await api.ejectProfile(info.token); toast(`${label} was ejected. Import ${info.file_name} to bring it back.`, "ok"); onEjected(st); } catch (e) { setErr(errText(e)); setBusy(false); }
  };

  return (
    <Modal title={eject ? "Eject" : "Save a backup copy"} onClose={onClose}>
      {!saved ? (
        <div style={{ display: "grid", gap: 10 }}>
          {eject ? (
            <>
              <p style={{ margin: 0 }}>Eject takes <b>{label}</b> off this device. First it saves everything to a file.</p>
              <p style={{ margin: 0 }}>This is <b>not a delete</b>. Import the file from the profile screen, on this device or another, and it comes back. Without the file, it can't.</p>
            </>
          ) : (
            <p style={{ margin: 0 }}>Saves a copy of <b>{label}</b> to a file you choose. Nothing is removed.</p>
          )}
          <p className="hint" style={{ margin: 0 }}>The file is <b>not encrypted</b>, so keep it somewhere safe. API keys and your passcode are not saved in it.</p>
          {err && <div className="hint" style={{ color: "var(--danger)" }} role="alert">{err}</div>}
          <div className="row"><button className="btn primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save my data"}</button><button className="btn" onClick={onClose}>Cancel</button></div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          <p style={{ margin: 0 }}><b>{info?.file_name}</b> was saved to <span style={{ wordBreak: "break-all" }}>{saved.path}</span>.</p>
          {info && <p className="hint" style={{ margin: 0 }}>{summary(info)}</p>}
          {saved.verified
            ? <p className="hint" style={{ margin: 0 }}>✓ The saved file was read back and matches.</p>
            : <p className="hint" style={{ margin: 0, color: eject ? "var(--danger)" : undefined }}>This location couldn't be double-checked. {eject ? "Nothing will be removed. Save it somewhere else." : "Look for the file to be sure it's there."}</p>}
          {eject && saved.verified && (
            <>
              <label className="row"><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> I have the file and I know where it is.</label>
              {err && <div className="hint" style={{ color: "var(--danger)" }} role="alert">{err}</div>}
              <div className="row"><button className="btn danger" disabled={!sure || busy} onClick={remove}>{busy ? "Removing…" : "Remove from this device"}</button><button className="btn" onClick={onClose}>Keep it here</button></div>
            </>
          )}
          {(!eject || !saved.verified) && <div className="row"><button className="btn primary" onClick={onClose}>Done</button></div>}
        </div>
      )}
    </Modal>
  );
}

function DeleteFlow({ expected, onClose, onDeleted }: { expected: string; onClose: () => void; onDeleted: (s: SessionState) => void }) {
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState("");
  return (
    <Modal title="Delete permanently" onClose={onClose}>
      <div style={{ display: "grid", gap: 10 }}>
        <p style={{ margin: 0 }}>This erases everything in <b>{expected}</b> and can't be undone. If you might want it back, use <b>Eject</b> instead, which saves a file first.</p>
        <label>Type <b>{expected}</b> to confirm<input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
        {err && <div className="hint" style={{ color: "var(--danger)" }} role="alert">{err}</div>}
        <div className="row">
          <button className="btn danger" disabled={typed.trim().toLowerCase() !== expected.toLowerCase()} onClick={async () => { try { onDeleted(await api.deleteProfile(typed)); } catch (e) { setErr(errText(e)); } }}>Delete everything</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
