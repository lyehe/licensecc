// Request-local response, parsing, and identity helpers shared by route owners.

import type { ApiEnvelope } from "../shared/api";
import type { Env } from "./env.js";
import { bearerToken, constantTimeEqual, readTextBody } from "@licensecc/cloudflare-runtime/http/kit";

export { bearerToken, constantTimeEqual };

const MAX_BODY_BYTES = 8192;
const PROJECT_RE = /^[A-Za-z0-9_.:-]{1,127}$/;
const FEATURE_RE = /^[A-Za-z0-9_.:-]{1,15}$/;

type LicenseMode = "trial" | "node_locked" | "floating";

export interface OwnedEntitlement {
  id: string;
  project: string;
  feature: string;
  license_fingerprint: string;
  status: string;
  valid_from: number | null;
  valid_until: number | null;
  pool_size: number;
  max_active_devices: number;
  max_borrow_sec: number;
  heartbeat_grace_sec: number;
  is_trial: number;
  policy_id: string | null;
  license_mode: LicenseMode;
}

export function json<T>(body: T, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function envelope<T>(reqId: string, code: string, data?: T, status = 200, headers: HeadersInit = {}): Response {
  const body: ApiEnvelope<T> = { ok: status >= 200 && status < 300, code, request_id: reqId };
  if (data !== undefined) body.data = data;
  return json(body, status, headers);
}

export function entitlementId(project: string, feature: string, licenseFingerprint: string): string {
  const raw = JSON.stringify([project, feature, licenseFingerprint]);
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeEntitlementId(id: string): { project: string; feature: string; license_fingerprint: string } | null {
  try {
    const padded = id.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(id.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [project, feature, licenseFingerprint] = parsed;
    if (typeof project !== "string" || typeof feature !== "string" || typeof licenseFingerprint !== "string") return null;
    if (!PROJECT_RE.test(project) || !FEATURE_RE.test(feature) || !/^[a-fA-F0-9]{64}$/.test(licenseFingerprint)) return null;
    return { project, feature, license_fingerprint: licenseFingerprint };
  } catch {
    return null;
  }
}

function licenseMode(row: { is_trial?: number; pool_size?: number }): LicenseMode {
  if (Number(row.is_trial ?? 0) === 1) return "trial";
  return Number(row.pool_size ?? 0) > 0 ? "floating" : "node_locked";
}

export function withPortalEntitlement(row: Omit<OwnedEntitlement, "id" | "license_mode">): OwnedEntitlement {
  return {
    ...row,
    id: entitlementId(row.project, row.feature, row.license_fingerprint),
    license_mode: licenseMode(row),
  };
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "";
}

// Cross-site rejection for state-changing POSTs: a same-origin app sends Origin == PORTAL_PUBLIC_ORIGIN
// (or Sec-Fetch-Site: same-origin). Anything cross-site is rejected (CSRF defense in depth; the
// session cookie is SameSite=Lax so a cross-site POST would not carry it, but we deny explicitly).
export function isCrossSite(request: Request, env: Env): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null) {
    return !(fetchSite === "same-origin" || fetchSite === "none");
  }
  const origin = request.headers.get("origin");
  if (origin === null) return false; // non-browser / no Origin: allow (cookie SameSite still gates).
  const expected = (env.PORTAL_PUBLIC_ORIGIN ?? "").replace(/\/$/, "");
  return expected.length === 0 ? true : origin.replace(/\/$/, "") !== expected;
}

export async function readJson(request: Request, reqId: string): Promise<Record<string, unknown> | Response> {
  const body = await readTextBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return envelope(reqId, "body_too_large", undefined, 413);
  }
  try {
    const text = body.text;
    const parsed = text === "" ? {} : JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return envelope(reqId, "invalid_json", undefined, 400);
    }
    return parsed as Record<string, unknown>;
  } catch {
    return envelope(reqId, "invalid_json", undefined, 400);
  }
}

export function publicOrigin(env: Env): string {
  return (env.PORTAL_PUBLIC_ORIGIN ?? "").replace(/\/$/, "");
}
