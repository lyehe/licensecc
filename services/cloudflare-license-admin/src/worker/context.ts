import type { Actor } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type { Env } from "./env.js";

export interface AdminRequestContext {
  readonly request: Request;
  readonly env: Env;
  readonly requestId: string;
  readonly actor: Actor | null;
  // Values are the raw pathname captures. Individual handlers retain the historical
  // decodeURIComponent calls where their IDs are user-facing text instead of opaque keys.
  readonly params: Readonly<Record<string, string>>;
}
