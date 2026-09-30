// Shared portal API types. Re-export the backend entitlement types so the portal Worker + (future)
// React UI share ONE shape with the licensing backend; add the portal-specific envelope.
export type {
  EntitlementStatus,
  EntitlementRecord,
} from "@licensecc/licensing-domain/entitlements/contracts";

export interface ApiEnvelope<T> {
  ok: boolean;
  code: string;
  request_id: string;
  data?: T;
  // Client-only: the `retry-after` response header (seconds), when the server sent one.
  // Never part of the server's JSON body -- api() (ui/shared/api.tsx) parses the header and attaches
  // it here so every caller reads one shape instead of re-parsing headers itself.
  retryAfter?: number;
}

// What the portal exposes to its own browser app (never the backend bearer; cookie only).
export interface PortalMe {
  customer_id: string;
  email: string | null;
}
