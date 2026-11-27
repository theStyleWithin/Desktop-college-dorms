/**
 * Things the app remembers on this device about what a person does (their chats with Tokenator, how they arranged the side bar, which panel they like in the
 * Gallery...) belong to the profile they are in: each profile, and the guest space, has its own, so nobody sees another person's. The app's screens are
 * rebuilt when the profile changes, so setting the profile once at the top of the app is enough.
 *
 * What was remembered before this existed was shared by everyone. The first profile that opens the app afterwards takes it over (once, and it is
 * removed from the shared place), rather than every profile getting a copy.
 */
let scope = "guest";
/** Tells this module whose things to keep (the profile's id, or nothing for the guest space). */
export const setProfileScope = (id: string | null | undefined) => { scope = id || "guest"; };
export const profileScope = () => scope;
const keyOf = (base: string) => `${base}.${scope}`;

export function sget(base: string): string | null {
  try {
    const k = keyOf(base);
    let v = localStorage.getItem(k);
    if (v === null) {
      const old = localStorage.getItem(base);
      if (old !== null) { localStorage.setItem(k, old); localStorage.removeItem(base); v = old; }
    }
    return v;
  } catch { return null; }
}
/** Remembers something for this profile. Throws if the storage is unavailable (callers already guard it). */
export const sset = (base: string, v: string) => localStorage.setItem(keyOf(base), v);
export const sdel = (base: string) => localStorage.removeItem(keyOf(base));
