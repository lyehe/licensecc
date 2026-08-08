import { loadSecretMap } from "./secret_map.mjs";

const TOKEN_PREFIX = "lcca_";
const PREFIX_DISPLAY_LEN = 12;
const TOKEN_BYTES = 32;
const textEncoder = new TextEncoder();

function base64FromBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64UrlFromBytes(bytes) {
  return base64FromBytes(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function generateAccountToken() {
  const random = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(random);
  const raw = TOKEN_PREFIX + base64UrlFromBytes(random);
  return { raw, token_prefix: raw.slice(0, PREFIX_DISPLAY_LEN) };
}

export async function hashToken(pepperBytes, rawTokenBytes) {
  const key = await crypto.subtle.importKey("raw", pepperBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, rawTokenBytes);
  return base64FromBytes(new Uint8Array(mac));
}

export function loadPepperMap(env) {
  return loadSecretMap(env?.ACCOUNT_TOKEN_PEPPERS);
}

export async function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const keyBytes = new Uint8Array(32);
  crypto.getRandomValues(keyBytes);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const macA = new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(a)));
  const macB = new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(b)));
  let diff = 0;
  for (let index = 0; index < macA.length; index += 1) diff |= macA[index] ^ macB[index];
  return diff === 0;
}
