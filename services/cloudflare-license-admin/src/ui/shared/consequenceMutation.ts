import { api } from "./api";
import { refusalOutcome } from "./messages";
import {
  confirmMutationUnknown,
  confirmSuccessWithRefreshFailure,
  EXACT_READ_PROOF,
  type ConfirmActionOutcome,
  type ConfirmActionResolution,
  type ExactReadProof,
  type KeyedMutationAttempt,
  type KeyedMutationParseResult,
} from "./operatorActions";

interface ConsequenceMutation<T> {
  readonly request: KeyedMutationAttempt;
  readonly runMutation: (work: () => Promise<unknown>, owner: "consequence" | "recovery") => Promise<unknown | undefined>;
  readonly parse: (value: unknown, phase: "initial" | "replay") => KeyedMutationParseResult<T>;
  readonly onApplied: (result: Extract<KeyedMutationParseResult<T>, { kind: "success" }>) => void;
  readonly refresh: () => Promise<ExactReadProof | null>;
  readonly captureRecoveryContext: () => void;
  readonly isCurrent: () => boolean;
}

export async function runConsequenceMutation<T>(action: ConsequenceMutation<T>): Promise<ConfirmActionOutcome> {
  const attempt = Object.freeze({ ...action.request });
  const send = async (): Promise<unknown> => {
    try {
      return await api<unknown>(attempt.path, {
        method: attempt.method,
        headers: { "idempotency-key": attempt.idempotencyKey },
        body: attempt.body,
      });
    } catch {
      return null;
    }
  };
  const refreshStatus = async (): Promise<ExactReadProof | null> => {
    action.captureRecoveryContext();
    return await action.refresh();
  };
  const postSuccessRefresh = confirmSuccessWithRefreshFailure(refreshStatus, action.isCurrent).manualRefresh;
  const replay = async (): Promise<ConfirmActionResolution> => {
    action.captureRecoveryContext();
    const retry = await action.runMutation(send, "recovery");
    if (retry === undefined || retry === null) return "indeterminate";
    const parsed = action.parse(retry, "replay");
    if (parsed.kind !== "success") return parsed.kind === "failure" ? "unapplied" : "indeterminate";
    try {
      return (await refreshStatus()) === EXACT_READ_PROOF ? "applied" : "refresh_failed";
    } catch {
      return "refresh_failed";
    }
  };
  const reconciliation = { label: "Reconcile status", run: replay, isCurrent: action.isCurrent, settlesRetainedAttempt: true, postSuccessRefresh };
  const mutation = await action.runMutation(send, "consequence");
  if (mutation === undefined) return refusalOutcome("mutation_busy", null);
  if (mutation === null) return confirmMutationUnknown(reconciliation);
  const parsed = action.parse(mutation, "initial");
  if (parsed.kind === "invalid") return confirmMutationUnknown(reconciliation);
  if (parsed.kind === "failure") return refusalOutcome(parsed.code, parsed.requestId);
  action.onApplied(parsed);
  try {
    return (await action.refresh()) === EXACT_READ_PROOF ? { ok: true } : confirmSuccessWithRefreshFailure(refreshStatus, action.isCurrent);
  } catch {
    return confirmSuccessWithRefreshFailure(refreshStatus, action.isCurrent);
  }
}
