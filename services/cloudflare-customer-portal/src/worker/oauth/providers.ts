import { createLocalJWKSet, jwtVerify } from "jose";
import type { Env } from "../env.js";

export type Provider = "google" | "github";
export interface Identity { provider: Provider; subject: string; email: string; name: string }
export function providerConfig(env: Env, provider: Provider): { id: string; secret: string } | null {
  const id = provider === "google" ? env.PORTAL_GOOGLE_CLIENT_ID : env.PORTAL_GITHUB_CLIENT_ID;
  const secret = provider === "google" ? env.PORTAL_GOOGLE_CLIENT_SECRET : env.PORTAL_GITHUB_CLIENT_SECRET;
  return id?.trim() && secret?.trim() ? { id, secret } : null;
}
export function randomToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
export async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// Workerd requires manual redirects; response.ok rejects them without forwarding credentials.
async function providerJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
    reader = response.body?.getReader();
    if (!response.ok || !reader) throw new Error("provider_unavailable");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) throw new Error("provider_response_too_large");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_identity");
  return value as Record<string, unknown>;
}
function email(value: unknown): string {
  if (typeof value !== "string" || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error("verified_email_required");
  return value.trim().toLowerCase();
}

export async function exchangeIdentity(env: Env, provider: Provider, code: string, verifier: string, nonce: string, redirectUri: string, now: number): Promise<Identity> {
  const config = providerConfig(env, provider);
  if (!config) throw new Error("provider_unavailable");
  const token = object(await providerJson(provider === "google" ? "https://oauth2.googleapis.com/token" : "https://github.com/login/oauth/access_token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: config.id, client_secret: config.secret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: "authorization_code" }).toString(),
  }));
  if (provider === "google") {
    if (typeof token.id_token !== "string") throw new Error("invalid_identity");
    const jwks = object(await providerJson("https://www.googleapis.com/oauth2/v3/certs"));
    if (!Array.isArray(jwks.keys)) throw new Error("invalid_identity");
    const { payload } = await jwtVerify(token.id_token, createLocalJWKSet({ keys: jwks.keys }), {
      issuer: ["https://accounts.google.com", "accounts.google.com"], audience: config.id,
      algorithms: ["RS256"], currentDate: new Date(now * 1000), requiredClaims: ["exp", "iat", "sub", "nonce"],
    });
    if (payload.nonce !== nonce || payload.email_verified !== true || !payload.sub || payload.sub.length > 255 ||
      (payload.azp !== undefined && payload.azp !== config.id) ||
      (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.id) ||
      (payload.iat ?? Infinity) > now + 60) throw new Error("invalid_identity");
    return { provider, subject: payload.sub, email: email(payload.email), name: typeof payload.name === "string" ? payload.name.slice(0, 128) : "" };
  }
  if (typeof token.access_token !== "string" || !token.access_token || String(token.token_type).toLowerCase() !== "bearer") throw new Error("invalid_identity");
  const headers = { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": "Licensecc-Portal", "X-GitHub-Api-Version": "2022-11-28" };
  const user = object(await providerJson("https://api.github.com/user", { headers }));
  const emails = await providerJson("https://api.github.com/user/emails?per_page=100", { headers });
  if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0 || !Array.isArray(emails)) throw new Error("invalid_identity");
  const primary = emails.map(object).find((item) => item.primary === true && item.verified === true);
  if (!primary) throw new Error("verified_email_required");
  return { provider, subject: String(user.id), email: email(primary.email), name: typeof user.name === "string" ? user.name.slice(0, 128) : "" };
}
