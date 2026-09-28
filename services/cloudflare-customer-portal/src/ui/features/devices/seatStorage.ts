import { checkoutPath, heartbeatPath, releasePath, SEATS_KEY, type SeatSession } from "../../portalWorkflow";
import { api } from "../../shared/api";
import type { SeatOperation } from "../../types";

// DevicesFeature.tsx's seat-storage/networking plumbing, split out into its own
// file so the local per-row/card result-line work added alongside it does not push that file over
// the 500-line hotspot limit.

export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function seatPath(operation: SeatOperation): string {
  if (operation === "checkout") return checkoutPath();
  if (operation === "heartbeat") return heartbeatPath();
  return releasePath();
}

// Seats now persist per CUSTOMER, not in one shared key -- a browser signed into
// several accounts in turn must never mix one customer's seats into another's storage.
function seatStorageKey(customerId: string): string {
  return `${SEATS_KEY}:${encodeURIComponent(customerId)}`;
}

export function readStoredSeats(customerId: string): string | null {
  try {
    return window.localStorage.getItem(seatStorageKey(customerId));
  } catch {
    return null;
  }
}

export function writeStoredSeats(customerId: string, json: string): void {
  try {
    window.localStorage.setItem(seatStorageKey(customerId), json);
  } catch {
    // Storage is best-effort. The in-memory map remains authoritative for this page lifetime.
  }
}

// Before this, every customer on a shared browser read and wrote the SAME
// unkeyed SEATS_KEY entry. That legacy entry has no reliable owner -- it could belong to whoever last
// signed in, not necessarily the customer signing in now -- so it is read once (nothing here adopts
// its value into anyone's live seat state) and discarded outright rather than migrated to the first
// customer key that happens to hydrate next. Nothing is lost forever: the server's own lease still
// expires an abandoned seat on its usual schedule regardless of what this browser remembers.
export function discardLegacyStoredSeats(): void {
  try {
    window.localStorage.removeItem(SEATS_KEY);
  } catch {
    // Storage is best-effort; nothing to discard if it is unavailable.
  }
}

// Sign-out best-effort releases every seat this browser holds, so the portal never keeps a
// floating seat checked out against a device the customer believes has signed out. Every stored seat
// is released in PARALLEL (one POST per entitlement) so N seats cost about the same wall-clock time
// as one, and every attempt races the SAME shared deadline so the whole batch is bounded to
// `timeoutMs` regardless of how many seats there are -- sign-out itself must never hang waiting on a
// slow or unreachable server. A seat that does not confirm success within that budget, or whose
// request fails outright, is reported "failed"; the caller (DevicesController) leaves it in
// seatSessions/storage so it is offered again after the next sign-in rather than silently dropped.
// A request that loses the race is never aborted, so a very late server-side success can still be
// recorded here as "failed" -- it self-heals on the next manual release attempt.
export async function runSeatSignOutReleases(
  seatSessions: Record<string, SeatSession>,
  timeoutMs = 5000,
): Promise<{ released: string[]; failed: string[] }> {
  const entries = Object.entries(seatSessions);
  if (entries.length === 0) return { released: [], failed: [] };
  const TIMED_OUT = Symbol("seat-signout-release-timeout");
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    const outcomes = await Promise.all(entries.map(async ([entitlementId, session]) => {
      const attempt = (async (): Promise<boolean> => {
        try {
          const result = await api<Record<string, unknown>>(releasePath(), {
            method: "POST",
            body: JSON.stringify({
              entitlement_id: entitlementId,
              seat_id: session.seat_id,
              client_instance_id: session.client_instance_id,
              nonce: randomHex(32),
            }),
          });
          return result.ok;
        } catch {
          // Defensive: api() itself no longer throws, but an unexpected throw here is equally "failed".
          return false;
        }
      })();
      const raced = await Promise.race([attempt, deadline]);
      return { entitlementId, ok: raced === TIMED_OUT ? false : raced };
    }));
    return {
      released: outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.entitlementId),
      failed: outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.entitlementId),
    };
  } finally {
    clearTimeout(timer!);
  }
}
