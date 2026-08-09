// Cloudflare Worker binding and request-context types for the customer portal.

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatement;
  withSession?(mode: string): D1DatabaseLike;
  batch?(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]>;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

// Example-config strings remain broad at runtime, but every resource binding
// continues to come from Wrangler's generated environment declaration.
type WidenWranglerStringBindings<Bindings extends object> = {
  [Binding in keyof Bindings]: Bindings[Binding] extends string ? string : Bindings[Binding];
};

type WithRuntimeNarrowing<Generated extends object, Runtime extends object> = Omit<Generated, keyof Runtime> & Runtime;

type IncompatibleGeneratedBindings<Generated extends object, Runtime extends object> = {
  [Binding in keyof Generated & keyof Runtime]: Generated[Binding] extends Runtime[Binding] ? never : Binding;
}[keyof Generated & keyof Runtime];

type AssertNoIncompatibleGeneratedBindings<Bindings extends never> = Bindings;

// Keep a direct generated dependency on each checked portal binding. This is
// deliberately not inferred from local names so config drift fails closed.
type WranglerBindings = Pick<Cloudflare.Env,
  | "DB"
  | "ASSETS"
  | "ENVIRONMENT"
  | "PORTAL_PUBLIC_ORIGIN"
  | "BACKEND_ORIGIN"
  | "PORTAL_EMAIL_FROM"
  | "PORTAL_EMAIL_API_BASE"
>;

interface RuntimeEnv {
  DB: D1DatabaseLike;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  ENVIRONMENT?: string;
  PORTAL_PUBLIC_ORIGIN?: string;
  BACKEND_ORIGIN?: string;
  PORTAL_OTP_PEPPERS?: string;
  PORTAL_SESSION_PEPPERS?: string;
  ACCOUNT_TOKEN_PEPPERS?: string;
  ACCOUNT_TOKEN_ACTIVE_PEPPER_ID?: string;
  PORTAL_EMAIL_API_KEY?: string;
  PORTAL_EMAIL_FROM?: string;
  PORTAL_EMAIL_API_BASE?: string;
  PORTAL_BOOTSTRAP_BEARER?: string;
  PORTAL_BOOTSTRAP_REQUIRE_ACCESS?: string;
}

type GeneratedBindingsMatchRuntime = AssertNoIncompatibleGeneratedBindings<
  IncompatibleGeneratedBindings<WidenWranglerStringBindings<WranglerBindings>, RuntimeEnv>
>;

export type Env = WithRuntimeNarrowing<WidenWranglerStringBindings<WranglerBindings>, RuntimeEnv>;

export type SessionRow = { customer_id: string; id: string };

export type TopRoute = (
  request: Request,
  env: Env,
  ctx: ExecutionContextLike | undefined,
  reqId: string,
  now: number,
) => Promise<Response> | Response;
