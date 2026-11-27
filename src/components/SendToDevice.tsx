import { useState } from "react";
import type { SendItem } from "../api";
import { useStore } from "../store";
import TransferDialog from "./TransferDialog";

/** A small button that sends one item (a character, persona, lorebook, note or saved prompt) to another device over the home Wi-Fi. */
export default function SendToDevice({ item, name, className = "btn sm" }: { item: SendItem; name: string; className?: string }) {
  const { session } = useStore();
  const [open, setOpen] = useState(false);
  const p = session.profile;
  return (
    <>
      <button type="button" className={className} title="Send this to your phone or another computer over Wi-Fi" aria-label={`Send ${name} to another device`} data-testid={`send-device-${item.kind}`} onClick={() => setOpen(true)}>📶 Send</button>
      {open && <TransferDialog item={{ ...item, name }} profileName={p ? p.display_name || p.handle : "the guest space"} hasPasscode={!!p?.has_passcode} onClose={() => setOpen(false)} />}
    </>
  );
}
