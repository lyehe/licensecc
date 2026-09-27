import { useEffect, useRef } from "react";

// D4: the native <dialog> pattern ProtectedNodes.tsx already used for its own disconnect confirm
// (showModal()/close() driven by a boolean, and focus returned to the section heading on every close --
// ProtectedNodes.tsx lines 21, 39, 60) factored out here so the legacy-device-release and floating-
// seat-release confirmations follow the SAME pattern instead of three separate copies. ProtectedNodes
// itself is untouched: its own inline effect keeps doing this itself, unchanged.
//
// Escape is handled by the caller's own <dialog onCancel={...}> (preventDefault, then call the same
// dismiss function the Cancel button uses) so a request in flight can veto it exactly like
// ProtectedNodes' close() does; this hook only owns opening/closing the element and the return-focus
// step common to both new dialogs.
export function useNativeDialogFocus(
  open: boolean,
  headingRef: React.RefObject<HTMLElement | null>,
): React.RefObject<HTMLDialogElement | null> {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      headingRef.current?.focus();
    }
  }, [open, headingRef]);
  return dialogRef;
}
