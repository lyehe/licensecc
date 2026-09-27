import type { ReactNode } from "react";

import type { FeedbackDetail } from "./operatorFeedback";

/*
 * The contract through which feature code hands confirmations, consequence
 * actions and keyed mutations to the operator controls. `controls.tsx`
 * re-exports all of it, so features keep importing from there.
 */

export type ConfirmFocusTarget = HTMLElement | null | (() => HTMLElement | null);

/**
 * The sole value a strict read may return to prove it issued, parsed, and
 * committed the current-context GET. `null` means stale/no-op/no proof.
 */
export const EXACT_READ_PROOF = Symbol("exact-read-proof");
export type ExactReadProof = typeof EXACT_READ_PROOF;

export interface ConfirmActionContext {
  idempotencyKey: string;
}

export interface ConfirmActionRecovery {
  label: string;
  run: () => Promise<ConfirmActionResolution>;
  isCurrent?: () => boolean;
  /** A same-key replay settles a retained request even if its old UI view is stale. */
  settlesRetainedAttempt?: boolean;
  /**
   * A write is already known to have applied, but its compulsory strict GET
   * failed. The GET-only recovery must be allowed to clear its notice after
   * the mutation's own form state advances during `onApplied`.
   */
  settlesKnownSuccess?: boolean;
  /**
   * A replay can prove that the write applied while its compulsory GET refresh
   * fails.  In that case the retained POST attempt is conclusively finished,
   * but the operator must be left with a GET-only recovery rather than another
   * replay of an already-known write.
   */
  postSuccessRefresh?: ConfirmActionRecovery;
}

export type ConfirmActionResolution = "applied" | "unapplied" | "indeterminate" | "refresh_failed";

export interface ConfirmActionSuccess {
  ok: true;
  warning?: string;
  manualRefresh?: ConfirmActionRecovery;
}

export interface ConfirmActionFailure {
  ok: false;
  /** The operator's sentence; its result code, if any, travels as `detail`. */
  message?: string;
  detail?: FeedbackDetail;
  retryable?: boolean;
  unknown?: boolean;
  reconciliation?: ConfirmActionRecovery;
}

export type ConfirmActionOutcome = ConfirmActionSuccess | ConfirmActionFailure;

export class ConfirmRefreshFailure extends Error {
  readonly code: string;
  readonly requestId: string;

  constructor(code: string, requestId: string) {
    super(`${code} (${requestId})`);
    this.name = "ConfirmRefreshFailure";
    this.code = code;
    this.requestId = requestId;
  }
}

export const CONFIRM_REFRESH_FAILURE_MESSAGE = "Action succeeded; status refresh failed";
export const CONFIRM_MUTATION_UNKNOWN_MESSAGE = "Mutation outcome unknown; do not retry.";

export function confirmMutationUnknown(reconciliation: ConfirmActionRecovery): ConfirmActionFailure {
  return { ok: false, message: CONFIRM_MUTATION_UNKNOWN_MESSAGE, retryable: false, unknown: true, reconciliation };
}

export function confirmSuccessWithRefreshFailure(refresh: () => Promise<ExactReadProof | null>, isCurrent?: () => boolean): ConfirmActionSuccess {
  return {
    ok: true,
    warning: CONFIRM_REFRESH_FAILURE_MESSAGE,
    manualRefresh: {
      label: "Refresh status",
      run: async () => (await refresh()) === EXACT_READ_PROOF ? "applied" : "indeterminate",
      isCurrent,
      settlesKnownSuccess: true,
    },
  };
}

export interface ConfirmAction {
  title: string;
  body: string;
  /** Optional server-derived consequence content rendered inside the shared dialog. */
  details?: ReactNode;
  requiresReason: boolean;
  /** Overrides the default "Confirm" button label. */
  confirmLabel?: string;
  /**
   * When set, the dialog renders a labelled text input and keeps Confirm
   * disabled until the typed value exactly matches this phrase (case-sensitive,
   * ends trimmed). The field is cleared every time the dialog opens.
   */
  typedConfirmation?: string;
  /** Buttons that fill the reason field with a fixed value; the field stays editable afterwards. */
  reasonPresets?: readonly string[];
  run: (context: ConfirmActionContext) => Promise<ConfirmActionOutcome>;
  successFocusTarget?: ConfirmFocusTarget;
  isCurrent?: () => boolean;
  reconciliation?: ConfirmActionRecovery;
}

export interface ConsequenceAction {
  run: (context: ConfirmActionContext) => Promise<ConfirmActionOutcome>;
  successFocusTarget?: ConfirmFocusTarget;
  isCurrent?: () => boolean;
  reconciliation?: ConfirmActionRecovery;
}

/** Immutable request material retained for exact same-key reconciliation. */
export interface KeyedMutationRequest {
  readonly method: "POST" | "PATCH";
  readonly path: string;
  readonly body: string;
}

export interface KeyedMutationAttempt extends KeyedMutationRequest {
  readonly idempotencyKey: string;
}

export type KeyedMutationParseResult<T> =
  | { kind: "success"; code: string; requestId: string; data: T }
  | { kind: "failure"; code: string; requestId: string; data?: unknown }
  | { kind: "invalid" };

/**
 * Shared lifecycle for ordinary keyed mutations.  It intentionally owns the
 * request key/body until an exact same-key replay proves applied or a
 * route-specific pre-mutation failure proves unapplied.
 */
export interface KeyedMutationAction<T> {
  readonly request: KeyedMutationRequest;
  readonly send: (attempt: Readonly<KeyedMutationAttempt>) => Promise<unknown>;
  readonly parse: (value: unknown, phase: "initial" | "replay") => KeyedMutationParseResult<T>;
  /**
   * Update local state/message only.  The strict read which makes that local
   * result safe to show lives in `refresh`, so a write success can never
   * silently swallow a stale or malformed post-success view.
   */
  readonly onApplied: (result: Extract<KeyedMutationParseResult<T>, { kind: "success" }>) => Promise<void> | void;
  /** A strict GET refresh that returns proof only after committing the current view. */
  readonly refresh: () => Promise<ExactReadProof | null>;
  readonly onUnapplied?: (result: Extract<KeyedMutationParseResult<T>, { kind: "failure" }>) => void;
  readonly successFocusTarget?: ConfirmFocusTarget;
  readonly isCurrent?: () => boolean;
  readonly recoveryLabel?: string;
}
