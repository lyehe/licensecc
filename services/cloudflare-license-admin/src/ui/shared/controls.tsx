import React, { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

interface ConfirmAction {
  title: string;
  body: string;
  requiresReason: boolean;
  run: () => Promise<void>;
}

interface OperatorControls {
  busy: boolean;
  currentReason: () => string;
  message: string;
  reason: string;
  requestConfirm: (action: ConfirmAction) => void;
  runMutation: (work: () => Promise<void>) => Promise<void>;
  setMessage: React.Dispatch<React.SetStateAction<string>>;
  setReason: React.Dispatch<React.SetStateAction<string>>;
}

const OperatorControlsContext = createContext<OperatorControls | null>(null);

export function OperatorControlsProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const reasonRef = useRef("");
  reasonRef.current = reason;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const currentReason = useCallback((): string => reasonRef.current, []);
  const dismissConfirm = useCallback((): void => {
    setConfirmAction(null);
    setReason("");
  }, []);
  const requestConfirm = useCallback((action: ConfirmAction): void => {
    setReason("");
    setConfirmAction(action);
  }, []);
  const runMutation = useCallback(async (work: () => Promise<void>): Promise<void> => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);
  const confirmProceed = useCallback(async (): Promise<void> => {
    const action = confirmAction;
    if (action === null || (action.requiresReason && currentReason().trim() === "")) {
      return;
    }
    setConfirmAction(null);
    await action.run();
  }, [confirmAction, currentReason]);

  useEffect(() => {
    if (confirmAction === null) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        dismissConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmAction, dismissConfirm]);

  return (
    <OperatorControlsContext.Provider value={{ busy, currentReason, message, reason, requestConfirm, runMutation, setMessage, setReason }}>
      {children}
      {confirmAction !== null && (
        <div className="modalOverlay" role="presentation" onClick={dismissConfirm}>
          <div className="modal danger" role="dialog" aria-modal="true" aria-labelledby="confirmTitle" onClick={(event) => event.stopPropagation()}>
            <h2 id="confirmTitle">{confirmAction.title}</h2>
            <p>{confirmAction.body}</p>
            {confirmAction.requiresReason && (
              <label className="reason">Reason (required)<input autoFocus value={reason} onChange={(event) => setReason(event.target.value)} /></label>
            )}
            <div className="actions">
              <button type="button" disabled={busy} onClick={dismissConfirm}>Cancel</button>
              <button
                type="button"
                className="danger"
                disabled={busy || (confirmAction.requiresReason && reason.trim() === "")}
                onClick={() => void confirmProceed()}
              >Confirm</button>
            </div>
          </div>
        </div>
      )}
    </OperatorControlsContext.Provider>
  );
}

export function useOperatorControls(): OperatorControls {
  const controls = useContext(OperatorControlsContext);
  if (controls === null) {
    throw new Error("operator_controls_provider_required");
  }
  return controls;
}
