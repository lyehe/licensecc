import { useEffect, useRef } from "react";

// The native <dialog> pattern ProtectedNodes.tsx already uses for its own disconnect confirmation
// (showModal()/close() driven by a boolean, and focus returned to the section heading on every close),
// factored out so the activated-device and seat release confirmations follow one pattern instead of
// separate copies. ProtectedNodes keeps its own inline effect, unchanged.
//
// Escape is handled by the caller's own <dialog onCancel={...}> (preventDefault, then the same dismiss
// the Cancel button uses) so a request in flight can refuse it; this hook only owns opening and closing
// the element and returning focus.
//
// The effect re-checks on every render rather than only when `open` changes: the dialog element can be
// replaced while `open` stays true (for example when the signed-in shell is swapped out and back), and a
// fresh element must be shown again or the page behind it would stay inert with nothing on screen. When
// the dialog closes after its section has gone (history navigation left the Devices page), focus falls
// back to the page content instead of being dropped on <body>.
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
      (headingRef.current ?? document.getElementById("content"))?.focus();
    }
  });
  return dialogRef;
}
