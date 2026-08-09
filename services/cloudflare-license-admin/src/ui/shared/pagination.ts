import type { Dispatch, SetStateAction } from "react";

import { api, apiFailureMessage, parseExactApiSuccess, type ExactUiApiSuccess, type UiApiEnvelope } from "./api";
import type { RequestFence } from "./requestFence";
import { csvExportPath, withCursor } from "./urls";

export { csvExportPath, withCursor } from "./urls";

export function pageAppendError<T>(
  existing: readonly T[],
  next: readonly T[],
  identity: (item: T) => string,
): "duplicate_page_item" | null {
  const seen = new Set(existing.map(identity));
  for (const item of next) {
    const id = identity(item);
    if (id === "" || seen.has(id)) {
      return "duplicate_page_item";
    }
    seen.add(id);
  }
  return null;
}

/**
 * A transport loss or 5xx tells us nothing about the cursor contract, so the
 * settled snapshot may offer the same append again. Any other failed exact
 * decode is a terminal protocol violation for this cursor: keeping it live
 * would turn a malformed page into an actionable retry loop.
 */
export function isRetryableAppendFailure(response: unknown): boolean {
  if (response === null || typeof response !== "object") {
    return false;
  }
  const status = (response as { readonly __httpStatus?: unknown }).__httpStatus;
  return status === 0 || (typeof status === "number" && Number.isInteger(status) && status >= 500 && status < 600);
}

export async function loadMore<T>(
  url: string,
  cursor: string | null,
  currentItems: readonly T[],
  setItems: Dispatch<SetStateAction<T[]>>,
  setCursor: Dispatch<SetStateAction<string | null>>,
  setMessage: Dispatch<SetStateAction<string>>,
  dataGuard: (value: unknown) => boolean,
  expectedCode: string,
  fence: RequestFence,
  identity: (item: T) => string,
): Promise<void> {
  if (cursor === null) {
    return;
  }
  const ticket = fence.beginLoadMore(cursor);
  if (ticket === null) {
    return;
  }
  let applied = false;
  try {
    const response = await api<{ items: T[]; next_cursor: string | null }>(withCursor(url, cursor));
    if (!fence.isLoadMoreCurrent(ticket)) {
      return;
    }
    const parsed = parseExactApiSuccess<{ items: T[]; next_cursor: string | null }>(response, expectedCode, dataGuard);
    if (parsed !== null) {
      const nextCursor = parsed.data.next_cursor ?? null;
      const appendError = pageAppendError(currentItems, parsed.data.items, identity);
      if (appendError !== null) {
        setMessage("invalid_api_response (duplicate_page_item)");
        setCursor((previous) => fence.isLoadMoreCurrent(ticket) && previous === cursor ? null : previous);
        fence.retireLoadMore(ticket);
      } else if (!fence.acceptsNextCursor(ticket, nextCursor)) {
        setMessage("invalid_api_response (repeated_cursor)");
        setCursor((previous) => fence.isLoadMoreCurrent(ticket) && previous === cursor ? null : previous);
        fence.retireLoadMore(ticket);
      } else {
        setItems((previous) => fence.isLoadMoreCurrent(ticket) ? [...previous, ...parsed.data.items] : previous);
        setCursor((previous) => fence.isLoadMoreCurrent(ticket) && previous === cursor ? nextCursor : previous);
        applied = true;
        fence.finishLoadMore(ticket, true, nextCursor);
      }
    } else {
      setMessage(apiFailureMessage(response));
      if (!isRetryableAppendFailure(response)) {
        setCursor((previous) => fence.isLoadMoreCurrent(ticket) && previous === cursor ? null : previous);
        fence.retireLoadMore(ticket);
      }
    }
  } finally {
    if (!applied) fence.finishLoadMore(ticket, false);
  }
}

export type ExactPagedRead<T> =
  | { kind: "success"; items: T[] }
  | { kind: "stale" }
  | { kind: "failure"; message: string };

/**
 * Selector controls must not silently expose only the first server page.  Read
 * every exact page into a local snapshot, then publish it only if its fence and
 * logical context still own the view.  Duplicate identities/cursors are an
 * invalid response rather than an opportunity to loop or present an ambiguous
 * partial selector.
 */
export async function loadAllExactPages<T>(
  url: string,
  expectedCode: string,
  dataGuard: (value: unknown) => boolean,
  fence: RequestFence,
  identity: (item: T) => string,
  isCurrent: () => boolean = () => true,
): Promise<ExactPagedRead<T>> {
  const ticket = fence.begin();
  const items: T[] = [];
  const identities = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const response: UiApiEnvelope<{ items: T[]; next_cursor: string | null }> = await api<{ items: T[]; next_cursor: string | null }>(cursor === null ? url : withCursor(url, cursor));
    if (!isCurrent() || !fence.isCurrent(ticket)) {
      return { kind: "stale" };
    }
    const parsed: ExactUiApiSuccess<{ items: T[]; next_cursor: string | null }> | null = parseExactApiSuccess<{ items: T[]; next_cursor: string | null }>(response, expectedCode, dataGuard);
    if (parsed === null) {
      return { kind: "failure", message: apiFailureMessage(response) };
    }
    for (const item of parsed.data.items) {
      const id = identity(item);
      if (id === "" || identities.has(id)) {
        return { kind: "failure", message: "invalid_api_response (duplicate_page_item)" };
      }
      identities.add(id);
      items.push(item);
    }
    cursor = parsed.data.next_cursor ?? null;
    if (cursor !== null && (cursors.has(cursor) || !cursors.add(cursor))) {
      return { kind: "failure", message: "invalid_api_response (repeated_cursor)" };
    }
  } while (cursor !== null);
  // Selector loads never expose a page cursor, but they still mark their
  // local request settled so a later context cannot adopt an older A snapshot.
  if (!isCurrent() || !fence.settle(ticket)) {
    return { kind: "stale" };
  }
  return { kind: "success", items };
}

export async function downloadCsv(
  listUrl: string,
  filename: string,
  runMutation: <T>(work: () => Promise<T>) => Promise<T | undefined>,
  setMessage: Dispatch<SetStateAction<string>>,
): Promise<void> {
  await runMutation(async () => {
    try {
      const response = await fetch(csvExportPath(listUrl));
      if (!response.ok) {
        setMessage(`csv_export_failed (${response.status})`);
        return;
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      setMessage(`exported ${filename}`);
    } catch {
      setMessage("csv_export_failed");
    }
  });
}
