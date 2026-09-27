import { useCallback, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ConfirmActionRecovery } from "./operatorActions";
import type { FeedbackDetail } from "./operatorFeedback";
import type { OperationGate } from "./operationGate";
import type { PendingFocus } from "./operatorFocus";

/*
 * The operator action notice: the banner that reports an operation's outcome,
 * may carry a recovery control, and while visible holds the operation slot.
 */

export interface ActionNotice {
  message: string;
  detail?: FeedbackDetail;
  manualRefresh?: ConfirmActionRecovery;
  focusTarget: PendingFocus;
  generation: number;
  dismissible?: boolean;
  unresolvedKey?: string;
}

export interface ActionNoticeControls {
  actionNotice: ActionNotice | null;
  noticePending: boolean;
  setNoticePending: Dispatch<SetStateAction<boolean>>;
  /** A recovery control, a retained key or a running recovery locks other operations. */
  operationLocked: boolean;
  actionNoticeRef: RefObject<ActionNotice | null>;
  noticePendingRef: RefObject<boolean>;
  publishActionNotice: (notice: Omit<ActionNotice, "generation">) => void;
  /** Revise the current notice in place, keeping its generation. */
  replaceActionNotice: (notice: ActionNotice) => void;
  clearActionNotice: () => void;
  acknowledgeNotice: () => void;
}

/**
 * `onPublish` runs whenever a notice is published: the notice is then the one surface for its
 * outcome, so an earlier page message, which no longer describes the page, can be cleared.
 */
export function useActionNotice({ operationOwnerRef, setOperationBusy }: OperationGate, onPublish?: () => void): ActionNoticeControls {
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);
  const [noticePending, setNoticePending] = useState(false);
  const actionNoticeRef = useRef<ActionNotice | null>(null);
  const noticePendingRef = useRef(false);
  const noticeGenerationRef = useRef(0);
  const onPublishRef = useRef(onPublish);
  onPublishRef.current = onPublish;
  actionNoticeRef.current = actionNotice;

  const publishActionNotice = useCallback((notice: Omit<ActionNotice, "generation">): void => {
    onPublishRef.current?.();
    const nextNotice = { ...notice, generation: noticeGenerationRef.current + 1 };
    noticeGenerationRef.current = nextNotice.generation;
    actionNoticeRef.current = nextNotice;
    setActionNotice(nextNotice);
  }, []);
  const clearActionNotice = useCallback((): void => {
    actionNoticeRef.current = null;
    setActionNotice(null);
  }, []);
  const replaceActionNotice = useCallback((notice: ActionNotice): void => {
    actionNoticeRef.current = notice;
    setActionNotice(notice);
  }, []);
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

  const operationLocked = actionNotice?.manualRefresh !== undefined || actionNotice?.unresolvedKey !== undefined || noticePending;
  return {
    actionNotice,
    noticePending,
    setNoticePending,
    operationLocked,
    actionNoticeRef,
    noticePendingRef,
    publishActionNotice,
    replaceActionNotice,
    clearActionNotice,
    acknowledgeNotice,
  };
}
