import { checkoutPath, heartbeatPath, releasePath, SEATS_KEY } from "../../portalWorkflow";
import type { SeatOperation } from "../../types";

// D2 (hotspot budget): DevicesFeature.tsx's seat-storage/networking plumbing, split out into its own
// file so the local per-row/card result-line work added alongside it does not push that file over
// the 500-line limit (task-D-common.md).

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

export function readStoredSeats(): string | null {
  try {
    return window.localStorage.getItem(SEATS_KEY);
  } catch {
    return null;
  }
}

export function writeStoredSeats(json: string): void {
  try {
    window.localStorage.setItem(SEATS_KEY, json);
  } catch {
    // Storage is best-effort. The in-memory map remains authoritative for this page lifetime.
  }
}
