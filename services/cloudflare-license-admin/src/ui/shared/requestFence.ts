import { useCallback, useMemo, useRef, useState } from "react";

export interface RequestTicket {
  readonly contextGeneration: number;
  readonly requestGeneration: number;
}

export interface LoadMoreTicket {
  readonly contextGeneration: number;
  /** The settled page-one snapshot this append is allowed to extend. */
  readonly baseRequestGeneration: number;
  readonly cursor: string;
}

export interface RequestFence {
  begin: () => RequestTicket;
  isCurrent: (ticket: RequestTicket) => boolean;
  /** Publish a page-one response as the current settled snapshot. */
  settle: (ticket: RequestTicket, nextCursor?: string | null) => boolean;
  /** Whether this context has a settled page-one snapshot to render. */
  isSettled: () => boolean;
  /** A cursor may append only when no newer page-one request is in flight. */
  canLoadMore: () => boolean;
  /** Starts one append without superseding its page-one base. */
  beginLoadMore: (cursor: string) => LoadMoreTicket | null;
  isLoadMoreCurrent: (ticket: LoadMoreTicket) => boolean;
  /** A candidate cursor must progress rather than repeat the base/page cursor. */
  acceptsNextCursor: (ticket: LoadMoreTicket, nextCursor: string | null) => boolean;
  /** Retire a malformed/non-progressing cursor so the UI cannot offer a no-op retry loop. */
  retireLoadMore: (ticket: LoadMoreTicket) => void;
  finishLoadMore: (ticket: LoadMoreTicket, applied: boolean, nextCursor?: string | null) => void;
}

/**
 * Fence both context changes and later requests in the same context. The
 * context counter deliberately never resets, so A → B → A cannot let the
 * original A response overwrite the later A view.
 */
export function useRequestFence(context: string): RequestFence {
  const state = useRef({
    context,
    contextGeneration: 0,
    requestGeneration: 0,
    settledRequestGeneration: null as number | null,
    loadingCursors: new Set<string>(),
    consumedCursors: new Set<string>(),
    issuedCursors: new Set<string>(),
  });
  const [, setRevision] = useState(0);
  const notify = useCallback((): void => setRevision((revision) => revision + 1), []);
  if (state.current.context !== context) {
    state.current = {
      context,
      contextGeneration: state.current.contextGeneration + 1,
      requestGeneration: 0,
      settledRequestGeneration: null,
      loadingCursors: new Set<string>(),
      consumedCursors: new Set<string>(),
      issuedCursors: new Set<string>(),
    };
  }
  const begin = useCallback((): RequestTicket => {
    state.current.requestGeneration += 1;
    // A same-context refresh keeps the settled rows available for focus and
    // comparison, but makes their cursor non-actionable until this new
    // page-one request settles.  A context change above is the only event
    // that immediately removes the old snapshot.
    state.current.loadingCursors.clear();
    state.current.consumedCursors.clear();
    state.current.issuedCursors.clear();
    notify();
    return {
      contextGeneration: state.current.contextGeneration,
      requestGeneration: state.current.requestGeneration,
    };
  }, [notify]);
  const isCurrent = useCallback((ticket: RequestTicket): boolean =>
    state.current.contextGeneration === ticket.contextGeneration &&
    state.current.requestGeneration === ticket.requestGeneration,
  []);
  const settle = useCallback((ticket: RequestTicket, nextCursor: string | null = null): boolean => {
    if (state.current.contextGeneration !== ticket.contextGeneration || state.current.requestGeneration !== ticket.requestGeneration) {
      return false;
    }
    if (nextCursor !== null) {
      state.current.issuedCursors.add(nextCursor);
    }
    state.current.settledRequestGeneration = ticket.requestGeneration;
    notify();
    return true;
  }, [notify]);
  const isSettled = useCallback((): boolean => state.current.settledRequestGeneration !== null, []);
  const canLoadMore = useCallback((): boolean =>
    state.current.settledRequestGeneration !== null &&
    state.current.settledRequestGeneration === state.current.requestGeneration,
  []);
  const beginLoadMore = useCallback((cursor: string): LoadMoreTicket | null => {
    if (cursor === "" || state.current.settledRequestGeneration === null || state.current.settledRequestGeneration !== state.current.requestGeneration || state.current.loadingCursors.has(cursor) || state.current.consumedCursors.has(cursor)) {
      return null;
    }
    state.current.loadingCursors.add(cursor);
    return {
      contextGeneration: state.current.contextGeneration,
      baseRequestGeneration: state.current.requestGeneration,
      cursor,
    };
  }, []);
  const isLoadMoreCurrent = useCallback((ticket: LoadMoreTicket): boolean =>
    state.current.contextGeneration === ticket.contextGeneration &&
    state.current.requestGeneration === ticket.baseRequestGeneration &&
    state.current.settledRequestGeneration === ticket.baseRequestGeneration,
  []);
  const acceptsNextCursor = useCallback((ticket: LoadMoreTicket, nextCursor: string | null): boolean => {
    if (!state.current.loadingCursors.has(ticket.cursor) || !(
      state.current.contextGeneration === ticket.contextGeneration &&
      state.current.requestGeneration === ticket.baseRequestGeneration &&
      state.current.settledRequestGeneration === ticket.baseRequestGeneration
    )) {
      return false;
    }
    return nextCursor === null || (nextCursor !== ticket.cursor && !state.current.issuedCursors.has(nextCursor));
  }, []);
  const retireLoadMore = useCallback((ticket: LoadMoreTicket): void => {
    if (
      state.current.contextGeneration === ticket.contextGeneration &&
      state.current.requestGeneration === ticket.baseRequestGeneration &&
      state.current.settledRequestGeneration === ticket.baseRequestGeneration
    ) {
      state.current.loadingCursors.delete(ticket.cursor);
      state.current.consumedCursors.add(ticket.cursor);
      notify();
    }
  }, [notify]);
  const finishLoadMore = useCallback((ticket: LoadMoreTicket, applied: boolean, nextCursor: string | null = null): void => {
    if (state.current.contextGeneration === ticket.contextGeneration) {
      state.current.loadingCursors.delete(ticket.cursor);
      if (applied && state.current.requestGeneration === ticket.baseRequestGeneration) {
        state.current.consumedCursors.add(ticket.cursor);
        if (nextCursor !== null) {
          state.current.issuedCursors.add(nextCursor);
        }
      }
      notify();
    }
  }, [notify]);
  return useMemo(() => ({ begin, isCurrent, settle, isSettled, canLoadMore, beginLoadMore, isLoadMoreCurrent, acceptsNextCursor, retireLoadMore, finishLoadMore }), [acceptsNextCursor, begin, beginLoadMore, canLoadMore, finishLoadMore, isCurrent, isLoadMoreCurrent, isSettled, retireLoadMore, settle]);
}
