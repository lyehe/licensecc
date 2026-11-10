import type { AssertNoIncompatibleGeneratedBindings, IncompatibleGeneratedBindings, WidenWranglerStringBindings, WithRuntimeNarrowing } from "@licensecc/cloudflare-runtime/bindings";
import type { D1DatabaseLike } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";

// Every checked config binding is named explicitly so a rename/removal is a
// type error rather than an unnoticed divergence from Worker composition.
type WranglerBindings = Pick<Cloudflare.Env,
  | "DB"
  | "DEVICE_OPERATOR"
  | "WEBHOOK_OPERATOR"
  | "ASSETS"
  | "ENVIRONMENT"
  | "ADMIN_DEV_BEARER_ENABLED"
  | "ADMIN_ACCESS_ISSUER"
  | "ADMIN_ACCESS_AUDIENCE"
  | "ADMIN_ACCESS_ADMIN_EMAILS"
  | "ADMIN_ACCESS_READER_EMAILS"
  | "PUBLIC_VERIFIER_URL"
>;

// Kept beside composition so Worker bindings remain explicit without coupling route groups
// to the entrypoint module.
interface RuntimeEnv {
  DB: D1DatabaseLike & { withSession?(mode: "first-primary"): D1DatabaseLike };
  DEVICE_OPERATOR?: Cloudflare.Env["DEVICE_OPERATOR"];
  WEBHOOK_OPERATOR?: Cloudflare.Env["WEBHOOK_OPERATOR"];
  ASSETS?: { fetch(request: Request): Promise<Response> };
  ENVIRONMENT?: string;
  ADMIN_DEV_BEARER_ENABLED?: string;
  ADMIN_DEV_BEARER?: string;
  ADMIN_ACCESS_ISSUER?: string;
  ADMIN_ACCESS_AUDIENCE?: string;
  ADMIN_ACCESS_JWKS_URL?: string;
  ADMIN_ACCESS_ADMIN_EMAILS?: string;
  ADMIN_ACCESS_READER_EMAILS?: string;
  PUBLIC_VERIFIER_URL?: string;
  SYNC_API_TOKEN?: string;
  POLICY_STAMP_MODE?: string;
}

type GeneratedBindingsMatchRuntime = AssertNoIncompatibleGeneratedBindings<
  IncompatibleGeneratedBindings<WidenWranglerStringBindings<WranglerBindings>, RuntimeEnv>
>;

export type Env = WithRuntimeNarrowing<WidenWranglerStringBindings<WranglerBindings>, RuntimeEnv>;
