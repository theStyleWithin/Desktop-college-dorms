import { useEffect, useState } from "react";
import { sdel, sget, sset } from "./scoped";

/**
 * Whether adding files to a character's gallery remembers where they are on this computer ("link") instead of making a copy. Off by default. It belongs to the
 * profile that chose it (see `lib/scoped`). Desktop only: a phone can't link to a file in place.
 */
const KEY = "dorms.gallery.linkfiles";

export const getLinkFiles = (): boolean => sget(KEY) === "1";

export function setLinkFiles(on: boolean) {
  try { if (on) sset(KEY, "1"); else sdel(KEY); } catch { /* storage unavailable: it still applies until the app is closed */ }
  window.dispatchEvent(new CustomEvent("dorms-link-files", { detail: on }));
}

/** The current choice and a way to change it; every control that shows it stays in step. */
export function useLinkFiles(): [boolean, (on: boolean) => void] {
  const [v, setV] = useState(getLinkFiles);
  useEffect(() => {
    const f = (e: Event) => setV(!!(e as CustomEvent<boolean>).detail);
    window.addEventListener("dorms-link-files", f);
    return () => window.removeEventListener("dorms-link-files", f);
  }, []);
  return [v, setLinkFiles];
}
