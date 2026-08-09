import React, { ReactNode, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

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

/**
 * A request context must advance even when its textual value returns to a prior
 * value (A → B → A). Equality alone would let an earlier response overwrite the
 * new A view or reclaim focus after the operator has moved on.
 */
export interface ContextGeneration {
  readonly generation: number;
  readonly isCurrent: (generation: number) => boolean;
  /** Capture the current generation immediately before starting a new request. */
  readonly currentGeneration: () => number;
  /** Read the current logical context without weakening generation freshness. */
  readonly currentContext: () => string;
}

export function useContextGeneration(context: string): ContextGeneration {
  const contextRef = useRef({ value: context, generation: 0 });
  if (contextRef.current.value !== context) {
    contextRef.current = { value: context, generation: contextRef.current.generation + 1 };
  }
  const isCurrent = useCallback((generation: number): boolean => contextRef.current.generation === generation, []);
  const currentGeneration = useCallback((): number => contextRef.current.generation, []);
  const currentContext = useCallback((): string => contextRef.current.value, []);
  return { generation: contextRef.current.generation, isCurrent, currentGeneration, currentContext };
}

export interface ConfirmActionSuccess {
  ok: true;
  warning?: string;
  manualRefresh?: ConfirmActionRecovery;
}

export interface ConfirmActionFailure {
  ok: false;
  message?: string;
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
  | { kind: "failure"; code: string; requestId: string }
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

interface OperatorControls {
  busy: boolean;
  /** A retained recovery owns the operation gate after its request settles. */
  operationLocked: boolean;
  currentReason: () => string;
  message: string;
  reason: string;
  requestConfirm: (action: ConfirmAction) => void;
  runConsequenceAction: (action: ConsequenceAction) => Promise<void>;
  runMutation: <T>(work: () => Promise<T>, owner?: "consequence" | "recovery") => Promise<T | undefined>;
  runKeyedMutation: <T>(action: KeyedMutationAction<T>) => Promise<void>;
  setMessage: React.Dispatch<React.SetStateAction<string>>;
  setReason: React.Dispatch<React.SetStateAction<string>>;
}

const OperatorControlsContext = createContext<OperatorControls | null>(null);

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  });
}

function focusElement(element: HTMLElement | null): boolean {
  if (element === null || element === document.body || !element.isConnected || element.hasAttribute("disabled")) {
    return false;
  }
  if (!element.matches(FOCUSABLE_SELECTOR) && !element.hasAttribute("tabindex")) {
    element.tabIndex = -1;
  }
  element.focus({ preventScroll: true });
  return document.activeElement === element;
}

function supportsNativeDialog(): boolean {
  return typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal === "function";
}

function resolveFocusTarget(target: ConfirmFocusTarget | undefined): HTMLElement | null {
  if (target === undefined || target === null) {
    return null;
  }
  return typeof target === "function" ? target() : target;
}

function dataAttributeSelector(attribute: string, value: string): string {
  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[${attribute}="${escaped}"]`;
}

function usableFocusTarget(element: HTMLElement | null): boolean {
  if (element === null || element === document.body || !element.isConnected || element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") {
    return false;
  }
  const style = window.getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none";
}

function stableFocusTarget(
  invokingElement: HTMLElement | null,
  rowKey: string | null,
  sectionKey: string | null,
): HTMLElement | null {
  if (usableFocusTarget(invokingElement)) {
    return invokingElement;
  }

  const row = rowKey === null
    ? invokingElement?.closest<HTMLElement>("[data-focus-row], tr, [role='row']") ?? null
    : document.querySelector<HTMLElement>(dataAttributeSelector("data-focus-row", rowKey));
  if (row !== null) {
    const transition = Array.from(row.querySelectorAll<HTMLElement>("[data-focus-action]")).find(usableFocusTarget);
    if (transition !== undefined) {
      return transition;
    }
    const statusOrHeading = row.querySelector<HTMLElement>(".status, [role='heading'], h1, h2, h3");
    if (usableFocusTarget(statusOrHeading)) {
      return statusOrHeading;
    }
    if (usableFocusTarget(row)) {
      return row;
    }
    const fallbackButton = Array.from(row.querySelectorAll<HTMLElement>("button")).find(usableFocusTarget);
    if (fallbackButton !== undefined) {
      return fallbackButton;
    }
  }

  const section = sectionKey === null
    ? invokingElement?.closest<HTMLElement>("[data-focus-section], section, aside") ?? null
    : document.querySelector<HTMLElement>(dataAttributeSelector("data-focus-section", sectionKey));
  if (section !== null) {
    const heading = section.querySelector<HTMLElement>("[role='heading'], h1, h2, h3, .status");
    if (usableFocusTarget(heading)) {
      return heading;
    }
    if (usableFocusTarget(section)) {
      return section;
    }
  }

  const globalHeading = document.querySelector<HTMLElement>("main h1, main h2, main h3, [role='main'] h1, [role='main'] h2, [role='main'] h3, h1, h2, h3");
  return usableFocusTarget(globalHeading) ? globalHeading : document.documentElement;
}

export function focusTargetInRow(rowKey: string, selectors: readonly string[]): ConfirmFocusTarget {
  return () => {
    const row = document.querySelector<HTMLElement>(dataAttributeSelector("data-focus-row", rowKey));
    if (row === null) {
      return null;
    }
    for (const selector of selectors) {
      const candidate = row.querySelector<HTMLElement>(selector);
      if (usableFocusTarget(candidate)) {
        return candidate;
      }
    }
    const statusOrHeading = row.querySelector<HTMLElement>(".status, [role='heading'], h1, h2, h3");
    return usableFocusTarget(statusOrHeading) ? statusOrHeading : row;
  };
}

export function focusTargetInSection(sectionKey: string): ConfirmFocusTarget {
  return () => {
    const section = document.querySelector<HTMLElement>(dataAttributeSelector("data-focus-section", sectionKey));
    if (section === null) {
      return null;
    }
    const heading = section.querySelector<HTMLElement>("[role='heading'], h1, h2, h3");
    return usableFocusTarget(heading) ? heading : section;
  };
}

interface PendingFocus {
  actionTarget?: ConfirmFocusTarget;
  invokingElement: HTMLElement | null;
  rowKey: string | null;
  sectionKey: string | null;
}

interface ActionNotice {
  message: string;
  manualRefresh?: ConfirmActionRecovery;
  focusTarget: PendingFocus;
  generation: number;
  dismissible?: boolean;
  unresolvedKey?: string;
}

interface UnresolvedOperation {
  idempotencyKey: string;
  focusTarget: PendingFocus;
  reconciliation?: ConfirmActionRecovery;
  request?: Readonly<KeyedMutationAttempt>;
}

type OperationOwner = "mutation" | "ordinary" | "consequence" | "recovery" | null;

function resolvePendingFocus(pending: PendingFocus): HTMLElement | null {
  let actionTarget: HTMLElement | null = null;
  try {
    actionTarget = resolveFocusTarget(pending.actionTarget);
  } catch {
    actionTarget = null;
  }
  if (usableFocusTarget(actionTarget)) {
    return actionTarget;
  }
  return stableFocusTarget(pending.invokingElement, pending.rowKey, pending.sectionKey);
}

/**
 * A stale retained replay is allowed to settle its immutable server request,
 * but its original row/section must not regain focus.  The shell's selected
 * navigation button is a live, current-context target that survives removal
 * of the recovery notice.
 */
function currentContextStableFocusTarget(): HTMLElement | null {
  const activeTab = document.querySelector<HTMLElement>("main > header.topbar nav button.active:not([disabled])");
  if (usableFocusTarget(activeTab)) {
    return activeTab;
  }
  const shellHeading = document.querySelector<HTMLElement>("main > header.topbar h1");
  return usableFocusTarget(shellHeading) ? shellHeading : null;
}

export function OperatorControlsProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const reasonRef = useRef("");
  reasonRef.current = reason;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // `busyRef` protects an individual request; this ref keeps the visual gate
  // closed through an owned post-success GET or active reconciliation.
  const operationBusyRef = useRef(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmUnknown, setConfirmUnknown] = useState(false);
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);
  const [noticePending, setNoticePending] = useState(false);
  const [focusGeneration, setFocusGeneration] = useState(0);
  const [nativeDialogEnabled, setNativeDialogEnabled] = useState(supportsNativeDialog);
  const confirmId = useId().replace(/:/g, "-");
  const titleId = `confirm-title-${confirmId}`;
  const descriptionId = `confirm-description-${confirmId}`;
  const errorId = `confirm-error-${confirmId}`;
  const nativeDialogRef = useRef<HTMLDialogElement | null>(null);
  const fallbackOverlayRef = useRef<HTMLDivElement | null>(null);
  const fallbackDialogRef = useRef<HTMLDivElement | null>(null);
  const reasonInputRef = useRef<HTMLInputElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const invokingElementRef = useRef<HTMLElement | null>(null);
  const invokingRowKeyRef = useRef<string | null>(null);
  const invokingSectionKeyRef = useRef<string | null>(null);
  const pendingRestoreFocusRef = useRef<PendingFocus | null>(null);
  const pendingSuccessFocusRef = useRef<PendingFocus | null>(null);
  const confirmPendingRef = useRef(false);
  const confirmAttemptKeyRef = useRef<string | null>(null);
  const noticePendingRef = useRef(false);
  const consequencePendingRef = useRef(false);
  const unresolvedOperationRef = useRef<UnresolvedOperation | null>(null);
  const operationOwnerRef = useRef<OperationOwner>(null);
  const actionNoticeRef = useRef<ActionNotice | null>(null);
  const confirmActionRef = useRef<ConfirmAction | null>(null);
  const noticeGenerationRef = useRef(0);
  actionNoticeRef.current = actionNotice;
  confirmActionRef.current = confirmAction;

  const currentReason = useCallback((): string => reasonRef.current, []);
  const setOperationBusy = useCallback((value: boolean): void => {
    operationBusyRef.current = value;
    setBusy(value || busyRef.current);
  }, []);
  const focusSoon = useCallback((element: HTMLElement | null): void => {
    if (focusElement(element)) {
      return;
    }
    if (element !== null && element.isConnected) {
      window.requestAnimationFrame(() => {
        focusElement(element);
      });
    }
  }, []);
  const capturePendingFocus = useCallback((actionTarget?: ConfirmFocusTarget): PendingFocus => {
    const activeElement = document.activeElement;
    const invokingElement = activeElement instanceof HTMLElement && activeElement !== document.body ? activeElement : null;
    const row = invokingElement?.closest<HTMLElement>("[data-focus-row], tr, [role='row']") ?? null;
    const section = invokingElement?.closest<HTMLElement>("[data-focus-section], section, aside") ?? null;
    return {
      actionTarget,
      invokingElement,
      rowKey: row?.getAttribute("data-focus-row") ?? null,
      sectionKey: section?.getAttribute("data-focus-section") ?? null,
    };
  }, []);
  const publishActionNotice = useCallback((notice: Omit<ActionNotice, "generation">): void => {
    const nextNotice = { ...notice, generation: noticeGenerationRef.current + 1 };
    noticeGenerationRef.current = nextNotice.generation;
    actionNoticeRef.current = nextNotice;
    setActionNotice(nextNotice);
  }, []);
  const clearActionNotice = useCallback((): void => {
    actionNoticeRef.current = null;
    setActionNotice(null);
  }, []);
  const dismissConfirm = useCallback((): void => {
    if (confirmPendingRef.current) {
      return;
    }
    pendingRestoreFocusRef.current = {
      invokingElement: invokingElementRef.current,
      rowKey: invokingRowKeyRef.current,
      sectionKey: invokingSectionKeyRef.current,
    };
    pendingSuccessFocusRef.current = null;
    invokingElementRef.current = null;
    invokingRowKeyRef.current = null;
    invokingSectionKeyRef.current = null;
    const keepConsequenceOwner = unresolvedOperationRef.current !== null || actionNoticeRef.current?.manualRefresh !== undefined;
    confirmAttemptKeyRef.current = null;
    setConfirmPending(false);
    setConfirmError(null);
    setConfirmUnknown(false);
    setConfirmAction(null);
    setReason("");
    if (!keepConsequenceOwner && operationOwnerRef.current === "consequence") {
      operationOwnerRef.current = null;
      setOperationBusy(false);
    }
  }, [setOperationBusy]);
  const requestConfirm = useCallback((action: ConfirmAction): void => {
    if (operationOwnerRef.current !== null || confirmPendingRef.current || consequencePendingRef.current || noticePendingRef.current || unresolvedOperationRef.current !== null || actionNoticeRef.current !== null) {
      return;
    }
    const pendingFocus = capturePendingFocus();
    invokingElementRef.current = pendingFocus.invokingElement;
    invokingRowKeyRef.current = pendingFocus.rowKey;
    invokingSectionKeyRef.current = pendingFocus.sectionKey;
    pendingRestoreFocusRef.current = null;
    pendingSuccessFocusRef.current = null;
    confirmAttemptKeyRef.current = crypto.randomUUID();
    setConfirmPending(false);
    setConfirmError(null);
    setConfirmUnknown(false);
    setReason("");
    operationOwnerRef.current = "consequence";
    setConfirmAction(action);
  }, [capturePendingFocus]);
  const runMutation = useCallback(async <T,>(work: () => Promise<T>, owner?: "consequence" | "recovery"): Promise<T | undefined> => {
    if (busyRef.current || (operationOwnerRef.current !== null && owner !== operationOwnerRef.current) || (operationOwnerRef.current === null && owner !== undefined)) {
      return undefined;
    }
    if (operationOwnerRef.current === null) {
      operationOwnerRef.current = "mutation";
    }
    busyRef.current = true;
    setBusy(true);
    try {
      return await work();
    } finally {
      busyRef.current = false;
      if (!operationBusyRef.current) {
        setBusy(false);
      }
      if (operationOwnerRef.current === "mutation") {
        operationOwnerRef.current = null;
      }
    }
  }, []);
  const runKeyedMutation = useCallback(async <T,>(action: KeyedMutationAction<T>): Promise<void> => {
    if (operationOwnerRef.current !== null || confirmPendingRef.current || consequencePendingRef.current || noticePendingRef.current || unresolvedOperationRef.current !== null || actionNoticeRef.current !== null) {
      return;
    }
    const focusTarget = capturePendingFocus(action.successFocusTarget);
    const attempt: Readonly<KeyedMutationAttempt> = Object.freeze({
      method: action.request.method,
      path: action.request.path,
      body: action.request.body,
      idempotencyKey: crypto.randomUUID(),
    });
    let retained = false;
    const strictRefresh: ConfirmActionRecovery = {
      label: "Refresh status",
      isCurrent: action.isCurrent,
      settlesKnownSuccess: true,
      run: async (): Promise<ConfirmActionResolution> => {
        // `onApplied` may intentionally clear an editable form and therefore
        // advance its mutation context.  This is still a mandatory strict GET:
        // the refresh callback carries the narrower list/detail fence that
        // prevents a stale response from changing a successor view.
        return (await action.refresh()) === EXACT_READ_PROOF ? "applied" : "indeterminate";
      },
    };
    const retainKnownRefreshFailure = (): void => {
      const message = CONFIRM_REFRESH_FAILURE_MESSAGE;
      pendingRestoreFocusRef.current = focusTarget;
      setFocusGeneration((generation) => generation + 1);
      setMessage(message);
      publishActionNotice({
        message,
        manualRefresh: strictRefresh,
        focusTarget,
        dismissible: false,
      });
    };
    const applyExactSuccess = async (result: Extract<KeyedMutationParseResult<T>, { kind: "success" }>): Promise<"applied" | "refresh_failed"> => {
      try {
        await action.onApplied(result);
        // A successful write is not presented as applied until its strict
        // read succeeds. `onApplied` is allowed to advance an editable form's
        // generation, so this intentionally delegates stale-view protection
        // to the narrower list/detail fence in the refresh callback.
        return await strictRefresh.run() === "applied" ? "applied" : "refresh_failed";
      } catch {
        // The write is known to have applied.  Its original immutable request
        // is no longer a recovery action: only a strict GET may resolve the
        // stale view, and it must never issue another POST.
        if (action.isCurrent?.() !== false) {
          setMessage(CONFIRM_REFRESH_FAILURE_MESSAGE);
        }
        return "refresh_failed";
      }
    };
    const retainUnknown = (): void => {
      retained = true;
      const reconciliation: ConfirmActionRecovery = {
        label: action.recoveryLabel ?? "Reconcile status",
        isCurrent: action.isCurrent,
        settlesRetainedAttempt: true,
        postSuccessRefresh: strictRefresh,
        run: async (): Promise<ConfirmActionResolution> => {
          const replay = await runMutation(() => action.send(attempt), "recovery");
          if (replay === undefined) {
            return "indeterminate";
          }
          let parsed: KeyedMutationParseResult<T>;
          try {
            parsed = action.parse(replay, "replay");
          } catch {
            return "indeterminate";
          }
          if (parsed.kind === "success") {
            return await applyExactSuccess(parsed);
          }
          if (parsed.kind === "failure") {
            action.onUnapplied?.(parsed);
            return "unapplied";
          }
          return "indeterminate";
        },
      };
      unresolvedOperationRef.current = { idempotencyKey: attempt.idempotencyKey, focusTarget, reconciliation, request: attempt };
      pendingRestoreFocusRef.current = focusTarget;
      setFocusGeneration((generation) => generation + 1);
      setMessage(CONFIRM_MUTATION_UNKNOWN_MESSAGE);
      publishActionNotice({
        message: CONFIRM_MUTATION_UNKNOWN_MESSAGE,
        manualRefresh: reconciliation,
        focusTarget,
        dismissible: false,
        unresolvedKey: attempt.idempotencyKey,
      });
    };
    operationOwnerRef.current = "ordinary";
    busyRef.current = true;
    setOperationBusy(true);
    try {
      let parsed: KeyedMutationParseResult<T>;
      try {
        parsed = action.parse(await action.send(attempt), "initial");
      } catch {
        retainUnknown();
        return;
      }
      if (parsed.kind === "success") {
        if (await applyExactSuccess(parsed) === "refresh_failed") {
          retainKnownRefreshFailure();
        }
        return;
      }
      if (parsed.kind === "failure") {
        if (action.onUnapplied !== undefined) {
          action.onUnapplied(parsed);
        } else if (action.isCurrent?.() !== false) {
          setMessage(`${parsed.code} (${parsed.requestId})`);
        }
        return;
      }
      retainUnknown();
    } finally {
      busyRef.current = false;
      if (!retained && operationOwnerRef.current === "ordinary") {
        operationOwnerRef.current = null;
      }
      setOperationBusy(false);
    }
  }, [capturePendingFocus, publishActionNotice, runMutation, setMessage, setOperationBusy]);
  const runConsequenceAction = useCallback(async (action: ConsequenceAction): Promise<void> => {
    if (operationOwnerRef.current !== null || confirmPendingRef.current || consequencePendingRef.current || noticePendingRef.current || unresolvedOperationRef.current !== null || actionNoticeRef.current !== null) {
      return;
    }
    const focusTarget = capturePendingFocus(action.successFocusTarget);
    const invokingElement = focusTarget.invokingElement;
    const idempotencyKey = crypto.randomUUID();
    operationOwnerRef.current = "consequence";
    setOperationBusy(true);
    consequencePendingRef.current = true;
    try {
      const outcome = await action.run({ idempotencyKey });
      if (outcome === undefined) {
        return;
      }
      if (!outcome.ok) {
        const message = outcome.message ?? (outcome.unknown === true ? CONFIRM_MUTATION_UNKNOWN_MESSAGE : "action_failed");
        const unknown = outcome.unknown === true || outcome.retryable === false;
        if (unknown) {
          unresolvedOperationRef.current = { idempotencyKey, focusTarget, reconciliation: outcome.reconciliation ?? action.reconciliation };
        }
        pendingRestoreFocusRef.current = focusTarget;
        setFocusGeneration((generation) => generation + 1);
        setMessage(message);
        publishActionNotice({ message, manualRefresh: unknown ? outcome.reconciliation ?? action.reconciliation : undefined, focusTarget, dismissible: !unknown, unresolvedKey: unknown ? idempotencyKey : undefined });
        return;
      }
      const current = action.isCurrent?.() !== false;
      const focusAllowed = current && (invokingElement === null || document.activeElement === invokingElement || document.activeElement === document.body);
      pendingSuccessFocusRef.current = focusAllowed ? focusTarget : null;
      if (outcome.warning !== undefined || outcome.manualRefresh !== undefined) {
        const message = outcome.warning ?? CONFIRM_REFRESH_FAILURE_MESSAGE;
        setMessage(message);
        publishActionNotice({ message, manualRefresh: outcome.manualRefresh, focusTarget });
      }
      setFocusGeneration((generation) => generation + 1);
    } catch {
      const message = CONFIRM_MUTATION_UNKNOWN_MESSAGE;
      unresolvedOperationRef.current = { idempotencyKey, focusTarget, reconciliation: action.reconciliation };
      pendingRestoreFocusRef.current = focusTarget;
      setFocusGeneration((generation) => generation + 1);
      setMessage(message);
      publishActionNotice({ message, manualRefresh: action.reconciliation, focusTarget, unresolvedKey: idempotencyKey });
    } finally {
      consequencePendingRef.current = false;
      const hasManualRefresh = (actionNoticeRef.current as ActionNotice | null)?.manualRefresh !== undefined;
      if (operationOwnerRef.current === "consequence" && unresolvedOperationRef.current === null && !hasManualRefresh) {
        operationOwnerRef.current = null;
      }
      // Retained/known-outcome notices still own the logical gate, but their
      // saved focus target must remain usable for accessible focus restoration.
      setOperationBusy(false);
    }
  }, [capturePendingFocus, publishActionNotice, setMessage, setOperationBusy]);
  const confirmProceed = useCallback(async (): Promise<void> => {
    const action = confirmAction;
    if (action === null || (action.requiresReason && currentReason().trim() === "")) {
      return;
    }
    if (confirmPendingRef.current) {
      return;
    }
    confirmPendingRef.current = true;
    setConfirmPending(true);
    setConfirmError(null);
    setConfirmUnknown(false);
    setOperationBusy(true);
    try {
      const idempotencyKey = confirmAttemptKeyRef.current ?? crypto.randomUUID();
      confirmAttemptKeyRef.current = idempotencyKey;
      const outcome = await action.run({ idempotencyKey });
      if (outcome === undefined || !outcome.ok) {
        const unknown = outcome === undefined || outcome.unknown === true || outcome.retryable === false;
        const message = outcome?.message ?? (unknown ? CONFIRM_MUTATION_UNKNOWN_MESSAGE : "action_failed");
        if (unknown) {
          const focusTarget: PendingFocus = {
            actionTarget: action.successFocusTarget,
            invokingElement: invokingElementRef.current,
            rowKey: invokingRowKeyRef.current,
            sectionKey: invokingSectionKeyRef.current,
          };
          const failure = outcome as ConfirmActionFailure | undefined;
          const reconciliation = failure?.reconciliation ?? action.reconciliation;
          unresolvedOperationRef.current = { idempotencyKey, focusTarget, reconciliation };
          publishActionNotice({ message, manualRefresh: reconciliation, focusTarget, dismissible: false, unresolvedKey: idempotencyKey });
        } else {
          // A documented pre-mutation rejection concludes this attempt.  Keep
          // the modal editable, but do not reuse its old idempotency key.
          confirmAttemptKeyRef.current = null;
        }
        setConfirmError(message);
        setConfirmUnknown(unknown);
        setConfirmPending(false);
        confirmPendingRef.current = false;
        setOperationBusy(false);
        return;
      }
      const successFocusTarget: PendingFocus = {
        actionTarget: action.successFocusTarget,
        invokingElement: invokingElementRef.current,
        rowKey: invokingRowKeyRef.current,
        sectionKey: invokingSectionKeyRef.current,
      };
      pendingSuccessFocusRef.current = action.isCurrent?.() === false ? null : successFocusTarget;
      invokingElementRef.current = null;
      invokingRowKeyRef.current = null;
      invokingSectionKeyRef.current = null;
      confirmAttemptKeyRef.current = null;
      setConfirmPending(false);
      confirmPendingRef.current = false;
      if (outcome.warning !== undefined || outcome.manualRefresh !== undefined) {
        const message = outcome.warning ?? CONFIRM_REFRESH_FAILURE_MESSAGE;
        setMessage(message);
        publishActionNotice({ message, manualRefresh: outcome.manualRefresh, focusTarget: successFocusTarget });
      }
      setConfirmAction(null);
      setReason("");
      const hasManualRefresh = (actionNoticeRef.current as ActionNotice | null)?.manualRefresh !== undefined;
      if (operationOwnerRef.current === "consequence" && !hasManualRefresh) {
        operationOwnerRef.current = null;
      }
      setOperationBusy(false);
    } catch (error) {
      const idempotencyKey = confirmAttemptKeyRef.current ?? crypto.randomUUID();
      confirmAttemptKeyRef.current = idempotencyKey;
      const focusTarget: PendingFocus = {
        actionTarget: action.successFocusTarget,
        invokingElement: invokingElementRef.current,
        rowKey: invokingRowKeyRef.current,
        sectionKey: invokingSectionKeyRef.current,
      };
      unresolvedOperationRef.current = { idempotencyKey, focusTarget, reconciliation: action.reconciliation };
      publishActionNotice({ message: CONFIRM_MUTATION_UNKNOWN_MESSAGE, manualRefresh: action.reconciliation, focusTarget, dismissible: false, unresolvedKey: idempotencyKey });
      setConfirmError(CONFIRM_MUTATION_UNKNOWN_MESSAGE);
      setConfirmUnknown(true);
      setConfirmPending(false);
      confirmPendingRef.current = false;
      setOperationBusy(false);
    }
  }, [confirmAction, currentReason, publishActionNotice, setMessage, setOperationBusy]);

  const runNoticeRecovery = useCallback(async (): Promise<void> => {
    const notice = actionNoticeRef.current;
    const recovery = notice?.manualRefresh;
    if (notice === null || notice === undefined || recovery === undefined || noticePendingRef.current) {
      return;
    }
    const focusTarget = notice.focusTarget;
    const generation = notice.generation;
    const recoveryTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const canRestoreFocus = (): boolean => {
      if (confirmActionRef.current !== null || recovery.isCurrent?.() === false) {
        return false;
      }
      return recoveryTrigger === null || document.activeElement === recoveryTrigger || document.activeElement === document.body;
    };
    const restoreNoticeFocus = (): void => {
      if (!canRestoreFocus()) {
        return;
      }
      window.requestAnimationFrame(() => focusSoon(resolvePendingFocus(focusTarget)));
    };
    noticePendingRef.current = true;
    operationOwnerRef.current = "recovery";
    setOperationBusy(true);
    setNoticePending(true);
    try {
      const resolution = await recovery.run();
      if (actionNoticeRef.current?.generation !== generation) {
        return;
      }
      if (recovery.isCurrent?.() === false && recovery.settlesRetainedAttempt !== true && recovery.settlesKnownSuccess !== true) {
        // A refresh for a superseded row/filter context cannot reconcile the
        // notice. Keep its recovery control until that context is current.
        return;
      }
      if (resolution === "refresh_failed") {
        // The same-key replay has given exact proof of the write. Clear its
        // immutable request/owner immediately and replace it with a GET-only
        // recovery. Replaying again here would turn a known success into a
        // second POST and make recovery less safe, not more.
        if (notice.unresolvedKey === undefined || recovery.postSuccessRefresh === undefined || unresolvedOperationRef.current?.idempotencyKey !== notice.unresolvedKey) {
          return;
        }
        unresolvedOperationRef.current = null;
        operationOwnerRef.current = null;
        const message = CONFIRM_REFRESH_FAILURE_MESSAGE;
        setMessage(message);
        publishActionNotice({
          message,
          manualRefresh: recovery.postSuccessRefresh,
          focusTarget,
          dismissible: false,
        });
        if (canRestoreFocus()) {
          pendingRestoreFocusRef.current = focusTarget;
          setFocusGeneration((current) => current + 1);
        }
        restoreNoticeFocus();
        return;
      }
      if (recovery.settlesKnownSuccess === true && resolution !== "applied") {
        // A known POST must never be treated as reconciled merely because its
        // old callback became a no-op after a form/filter context changed.
        // Retain the GET-only notice until a current exact read supplies proof.
        if (canRestoreFocus()) {
          pendingRestoreFocusRef.current = focusTarget;
          setFocusGeneration((current) => current + 1);
        }
        setMessage(CONFIRM_REFRESH_FAILURE_MESSAGE);
        restoreNoticeFocus();
        return;
      }
      if (notice.unresolvedKey !== undefined && resolution === "indeterminate") {
        if (canRestoreFocus()) {
          pendingRestoreFocusRef.current = focusTarget;
          setFocusGeneration((current) => current + 1);
        }
        const message = CONFIRM_MUTATION_UNKNOWN_MESSAGE;
        setMessage(message);
        const currentNotice = actionNoticeRef.current;
        if (currentNotice?.generation === generation && currentNotice.message !== message) {
          const updatedNotice = { ...currentNotice, message };
          actionNoticeRef.current = updatedNotice;
          setActionNotice(updatedNotice);
        }
        restoreNoticeFocus();
        return;
      }
      if (notice.unresolvedKey !== undefined) {
        if (unresolvedOperationRef.current?.idempotencyKey !== notice.unresolvedKey) {
          return;
        }
        unresolvedOperationRef.current = null;
      }
      const focusAllowed = canRestoreFocus();
      const staleRetainedReplay = !focusAllowed
        && recovery.settlesRetainedAttempt === true
        && recovery.isCurrent?.() === false;
      if (focusAllowed) {
        // The recovery control is about to unmount. Move focus before that
        // happens, then let the post-render pass refine it against refreshed
        // row data; otherwise browsers may transiently fall back to <body>.
        focusSoon(resolvePendingFocus(focusTarget));
        pendingSuccessFocusRef.current = focusTarget;
      } else if (staleRetainedReplay) {
        // The old presentation is stale, so never resolve its Catalog/row
        // target. Move from the soon-to-unmount notice to a live shell target
        // before clearing it, then reaffirm after React removes the notice.
        focusSoon(currentContextStableFocusTarget());
      }
      clearActionNotice();
      operationOwnerRef.current = null;
      setOperationBusy(false);
      // Do not leave the global status stale after a recovery resolves.  A
      // terminal Worker rejection is just as conclusive as an applied replay:
      // both release the retained key and the shared operation owner.
      setMessage(resolution === "unapplied" ? "Mutation was not applied." : "Status reconciled.");
      if (focusAllowed) {
        setFocusGeneration((current) => current + 1);
      }
      restoreNoticeFocus();
      if (staleRetainedReplay) {
        window.requestAnimationFrame(() => {
          if (confirmActionRef.current === null) {
            focusSoon(currentContextStableFocusTarget());
          }
        });
      }
    } catch {
      if (actionNoticeRef.current?.generation === generation) {
        if (canRestoreFocus()) {
          pendingRestoreFocusRef.current = focusTarget;
          setFocusGeneration((current) => current + 1);
        }
        setMessage("status_refresh_failed");
        restoreNoticeFocus();
      }
    } finally {
      noticePendingRef.current = false;
      setNoticePending(false);
      setOperationBusy(false);
      if (recovery.isCurrent?.() === false && actionNoticeRef.current?.generation === generation && recoveryTrigger !== null) {
        window.requestAnimationFrame(() => {
          if (actionNoticeRef.current?.generation === generation && (document.activeElement === document.body || document.activeElement === recoveryTrigger)) {
            focusSoon(recoveryTrigger);
          }
        });
      }
    }
  }, [clearActionNotice, focusSoon, publishActionNotice, setMessage, setOperationBusy]);

  const acknowledgeNotice = useCallback((): void => {
    if (noticePendingRef.current || actionNoticeRef.current === null || actionNoticeRef.current.unresolvedKey !== undefined) {
      return;
    }
    clearActionNotice();
    if (operationOwnerRef.current === "consequence") {
      operationOwnerRef.current = null;
      setOperationBusy(false);
    }
  }, [clearActionNotice, setOperationBusy]);

  useLayoutEffect(() => {
    if (confirmAction !== null) {
      return;
    }
    const pendingFocus = pendingSuccessFocusRef.current ?? pendingRestoreFocusRef.current;
    pendingSuccessFocusRef.current = null;
    pendingRestoreFocusRef.current = null;
    if (pendingFocus === null) {
      return;
    }
    const focusAfterRefresh = (): void => {
      focusSoon(resolvePendingFocus(pendingFocus));
    };
    // Native <dialog> returns focus to <body> as it closes.  Restore a stable
    // in-app target in this layout pass, then refine after any row refresh has
    // rendered.  Deferring both attempts leaves a visible/body-focus gap when
    // an unknown outcome disables the invoking destructive control.
    focusAfterRefresh();
    window.requestAnimationFrame(focusAfterRefresh);
  }, [confirmAction, focusGeneration, focusSoon]);

  useLayoutEffect(() => {
    if (confirmAction === null || confirmPending || confirmError === null) {
      return;
    }
    focusSoon(errorRef.current ?? confirmButtonRef.current ?? cancelButtonRef.current);
  }, [confirmAction, confirmError, confirmPending, focusSoon]);

  useLayoutEffect(() => {
    if (confirmAction === null || !confirmPending) {
      return;
    }
    const dialog = nativeDialogEnabled ? nativeDialogRef.current : fallbackDialogRef.current;
    if (dialog !== null && !dialog.contains(document.activeElement)) {
      focusSoon(confirmButtonRef.current ?? dialog);
    }
  }, [confirmAction, confirmPending, focusSoon, nativeDialogEnabled]);

  useLayoutEffect(() => {
    if (confirmAction === null) {
      return;
    }
    const dialog = nativeDialogEnabled ? nativeDialogRef.current : fallbackDialogRef.current;
    const modalContainer = nativeDialogEnabled ? nativeDialogRef.current : fallbackOverlayRef.current;
    if (dialog === null || modalContainer === null) {
      return;
    }
    if (nativeDialogEnabled && nativeDialogRef.current !== null && !nativeDialogRef.current.open) {
      try {
        nativeDialogRef.current.showModal();
      } catch {
        setNativeDialogEnabled(false);
        return;
      }
    }

    const backgroundRoot = modalContainer.parentElement;
    const backgroundElements = backgroundRoot === null
      ? []
      : Array.from(backgroundRoot.children)
        .filter((element) => element !== modalContainer)
        .map((element) => element as HTMLElement);
    const previousBackgroundState = backgroundElements.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    for (const element of backgroundElements) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }

    const initialFocus = confirmAction.requiresReason ? reasonInputRef.current : cancelButtonRef.current;
    focusSoon(initialFocus ?? dialog);

    return () => {
      for (const previous of previousBackgroundState) {
        previous.element.inert = previous.inert;
        if (previous.ariaHidden === null) {
          previous.element.removeAttribute("aria-hidden");
        } else {
          previous.element.setAttribute("aria-hidden", previous.ariaHidden);
        }
      }
      if (nativeDialogEnabled && dialog instanceof HTMLDialogElement && dialog.open) {
        dialog.close();
      }
    };
  }, [confirmAction, focusSoon, nativeDialogEnabled]);

  useEffect(() => {
    if (confirmAction === null) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      const dialog = nativeDialogEnabled ? nativeDialogRef.current : fallbackDialogRef.current;
      if (dialog === null) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!confirmPendingRef.current) {
          dismissConfirm();
        }
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = focusableElements(dialog);
      event.stopPropagation();
      event.preventDefault();
      if (focusable.length === 0) {
        dialog.focus({ preventScroll: true });
        return;
      }
      const activeElement = document.activeElement;
      const currentIndex = activeElement instanceof HTMLElement ? focusable.indexOf(activeElement) : -1;
      if (currentIndex < 0) {
        (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus({ preventScroll: true });
      } else if (event.shiftKey) {
        focusable[(currentIndex - 1 + focusable.length) % focusable.length].focus({ preventScroll: true });
      } else {
        focusable[(currentIndex + 1) % focusable.length].focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [confirmAction, dismissConfirm, nativeDialogEnabled]);

  const modalContent = confirmAction === null ? null : (
    <div className="modalSurface" onClick={(event) => event.stopPropagation()}>
      <h2 id={titleId}>{confirmAction.title}</h2>
      <p id={descriptionId}>{confirmAction.body}</p>
      {confirmAction.details !== undefined && <section className="modalDetails" aria-label="Action consequences">{confirmAction.details}</section>}
      {confirmPending && <p className="modalProgress" role="status" aria-live="polite">Working…</p>}
      {confirmError !== null && <p ref={errorRef} id={errorId} className="modalError" role="alert" tabIndex={-1}>{confirmError}</p>}
      {confirmAction.requiresReason && (
        <label className="reason">Reason (required)<input ref={reasonInputRef} autoFocus disabled={confirmPending} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      )}
      <div className="actions">
        <button ref={cancelButtonRef} type="button" autoFocus={!confirmAction.requiresReason} disabled={confirmPending} onClick={dismissConfirm}>Cancel</button>
        <button
          ref={confirmButtonRef}
          type="button"
          className="danger"
          disabled={!confirmPending && (confirmUnknown || busy || (confirmAction.requiresReason && reason.trim() === ""))}
          aria-disabled={confirmPending ? "true" : undefined}
          onClick={() => void confirmProceed()}
        >Confirm</button>
      </div>
    </div>
  );

  const operationLocked = actionNotice?.manualRefresh !== undefined || actionNotice?.unresolvedKey !== undefined || noticePending;

  return (
    <OperatorControlsContext.Provider value={{ busy, operationLocked, currentReason, message, reason, requestConfirm, runConsequenceAction, runKeyedMutation, runMutation, setMessage, setReason }}>
      {children}
      {actionNotice !== null && (
      <div className="operatorNotice" role="status" aria-live="polite">
          <span>{actionNotice.message}</span>
          {actionNotice.unresolvedKey !== undefined && <span>Other actions are unavailable until reconciliation completes.</span>}
          {actionNotice.manualRefresh !== undefined && <button type="button" disabled={noticePending} onClick={() => void runNoticeRecovery()}>{noticePending ? "Refreshing…" : actionNotice.manualRefresh.label}</button>}
          {actionNotice.dismissible === true && <button type="button" disabled={noticePending} onClick={acknowledgeNotice}>Acknowledge</button>}
        </div>
      )}
      {confirmAction !== null && nativeDialogEnabled && (
        <dialog
          ref={nativeDialogRef}
          className="modal danger"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={confirmError === null ? descriptionId : `${descriptionId} ${errorId}`}
          aria-busy={confirmPending}
          tabIndex={-1}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              dismissConfirm();
            }
          }}
          onCancel={(event) => {
            event.preventDefault();
            dismissConfirm();
          }}
        >
          {modalContent}
        </dialog>
      )}
      {confirmAction !== null && !nativeDialogEnabled && (
        <div ref={fallbackOverlayRef} className="modalOverlay" role="presentation" onClick={dismissConfirm}>
          <div ref={fallbackDialogRef} className="modal danger" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={confirmError === null ? descriptionId : `${descriptionId} ${errorId}`} aria-busy={confirmPending} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
            {modalContent}
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
