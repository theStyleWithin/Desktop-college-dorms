import { useState } from "react";
import { api } from "../api";
import { errText } from "../lib/util";
import { useToast } from "./ui";

/**
 * "Paste a picture link": a box and a button that fetch a picture, GIF or short video from a web address (the app fetches it, checks by the
 * file's first bytes what it is, and hands it over as an ordinary file). What happens to the file next is the caller's business, so this works
 * the same wherever a picture can be added.
 */
export default function PictureLinkBox({ onFile, busy, testid = "picture-link", placeholder = "…or paste a picture link (https://…)" }: { onFile: (f: File) => Promise<void> | void; busy?: boolean; testid?: string; placeholder?: string }) {
  const toast = useToast();
  const [link, setLink] = useState("");
  const [fetching, setFetching] = useState(false);
  const use = async () => {
    if (fetching || busy || !link.trim()) return;
    setFetching(true);
    try { const f = await api.fetchPicture(link); setLink(""); await onFile(f); }
    catch (e) { toast(errText(e), "err"); }
    finally { setFetching(false); }
  };
  return (
    <div className="plb" data-testid={`${testid}-box`}>
      <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
        <input type="text" inputMode="url" value={link} placeholder={placeholder} aria-label="Picture link" data-testid={`${testid}-input`} maxLength={2000} style={{ minWidth: 0, flex: 1 }}
          onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void use(); } }} />
        <button type="button" className="btn" disabled={fetching || !!busy || !link.trim()} data-testid={`${testid}-use`} onClick={() => void use()}>{fetching ? "Fetching…" : "Use link"}</button>
      </div>
      <small className="muted">On a web page, right-click a picture and choose Copy image address, then paste it here.</small>
    </div>
  );
}

/** A picture copied from the internet (Copy image) and pasted: the first image on the clipboard, as a file. */
export function pastedPicture(e: React.ClipboardEvent): File | null {
  const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith("image/"));
  if (!f) return null;
  return f.name && /\.\w+$/.test(f.name) ? f : new File([f], `pasted.${f.type.split("/")[1] || "png"}`, { type: f.type });
}
