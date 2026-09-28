import { useCallback, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ConfirmActionRecovery, KeyedMutationAttempt } from "./operatorActions";
import type { PendingFocus } from "./operatorFocus";

/*
 * The single operation slot the operator controls share. The confirmation
 * dialog, consequence actions and keyed mutations check it before starting and
 * notice recovery claims it while it runs, so only one operation owns the
 * console at a time.
 */

export interface UnresolvedOperation {
  idempotencyKey: string;
  focusTarget: PendingFocus;
  reconciliation?: ConfirmActionRecovery;
  request?: Readonly<KeyedMutationAttempt>;
}

export type OperationOwner = "mutation" | "ordinary" | "consequence" | "recovery" | null;

export interface OperationGate {
  busy: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
  busyRef: RefObject<boolean>;
  operationBusyRef: RefObject<boolean>;
  operationOwnerRef: RefObject<OperationOwner>;
  /** The open confirmation's request is in flight. */
  confirmPendingRef: RefObject<boolean>;
  /** A direct consequence action's request is in flight. */
  consequencePendingRef: RefObject<boolean>;
  /** A request whose outcome is unknown keeps its key until reconciled. */
  unresolvedOperationRef: RefObject<UnresolvedOperation | null>;
  setOperationBusy: (value: boolean) => void;
}

export function useOperationGate(): OperationGate {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // `busyRef` protects an individual request; this ref keeps the visual gate
  // closed through an owned post-success GET or active reconciliation.
  const operationBusyRef = useRef(false);
  const operationOwnerRef = useRef<OperationOwner>(null);
  const confirmPendingRef = useRef(false);
  const consequencePendingRef = useRef(false);
  const unresolvedOperationRef = useRef<UnresolvedOperation | null>(null);
  const setOperationBusy = useCallback((value: boolean): void => {
    operationBusyRef.current = value;
    setBusy(value || busyRef.current);
  }, []);
  return { busy, setBusy, busyRef, operationBusyRef, operationOwnerRef, confirmPendingRef, consequencePendingRef, unresolvedOperationRef, setOperationBusy };
}
