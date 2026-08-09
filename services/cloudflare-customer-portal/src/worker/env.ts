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
  batch?(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
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

export type SessionRow = { customer_id: string; id: string };

export type TopRoute = (
  request: Request,
  env: Env,
  ctx: ExecutionContextLike | undefined,
  reqId: string,
  now: number,
) => Promise<Response> | Response;
