import { parseBoundJson, BoundRequestError } from "./bound_request.mjs";
import { boundLeaseKeyId } from "./bound_crypto.mjs";

function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
      || keys.some(key => !Object.hasOwn(value, key))) throw new Error("invalid_config");
}
function identifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,127}$/.test(value)) throw new Error("invalid_config");
}
function destination(value) {
  if (typeof value !== "string" || value.length > 1024 || value.includes("?") || value.includes("#")) throw new Error("invalid_config");
  const url = new URL(value);
  if (url.href !== value || url.protocol !== "https:" || url.username || url.password) throw new Error("invalid_config");
}

export function boundDeviceConfig(env) {
  try {
    if (typeof env.BOUND_DEVICE_CONFIG !== "string") throw new Error("missing_config");
    const config = parseBoundJson(new TextEncoder().encode(env.BOUND_DEVICE_CONFIG));
    exact(config, ["issuer", "audience", "authorization_url", "clients"]);
    destination(config.issuer); destination(config.authorization_url); identifier(config.audience);
    if (!Array.isArray(config.clients) || config.clients.length < 1 || config.clients.length > 32) throw new Error("invalid_config");
    const ids = new Set();
    for (const client of config.clients) {
      exact(client, ["client_id", "project", "display_name", "callbacks"]);
      identifier(client.client_id); identifier(client.project);
      if (ids.has(client.client_id)) throw new Error("duplicate_client");
      ids.add(client.client_id);
      if (typeof client.display_name !== "string" || client.display_name !== client.display_name.trim()
          || [...client.display_name].length < 1 || [...client.display_name].length > 80) throw new Error("invalid_config");
      if (!Array.isArray(client.callbacks) || client.callbacks.length < 1 || client.callbacks.length > 8) throw new Error("invalid_config");
      const callbacks = new Set();
      for (const callback of client.callbacks) {
        exact(callback, ["host", "path"]);
        if (!["127.0.0.1", "[::1]"].includes(callback.host) || typeof callback.path !== "string"
            || !callback.path.startsWith("/") || callback.path.length > 512 || /[?#]/.test(callback.path)) throw new Error("invalid_config");
        const uri = `http://${callback.host}:12345${callback.path}`;
        if (new URL(uri).href !== uri || callbacks.has(uri)) throw new Error("invalid_config");
        callbacks.add(uri);
      }
    }
    return { issuer: config.issuer, audience: config.audience, authorizationUrl: config.authorization_url, clients: config.clients };
  } catch { throw new BoundRequestError("temporarily_unavailable", 503); }
}

function pemBytes(pem, label) {
  if (typeof pem !== "string" || pem.length > 8192) throw new Error("invalid_signer");
  const match = new RegExp(`^-----BEGIN ${label}-----\\r?\\n([A-Za-z0-9+/=\\r\\n]+)\\r?\\n-----END ${label}-----$`).exec(pem.trim());
  if (!match) throw new Error("invalid_signer");
  const encoded = match[1].replace(/[\r\n]/g, "");
  const binary = atob(encoded);
  if (btoa(binary) !== encoded) throw new Error("invalid_signer");
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

// No reuse/fallback to the legacy v201 or online-assertion signing secrets.
export async function loadBoundSigner(env) {
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const publicBytes = pemBytes(env.BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM, "PUBLIC KEY");
  const publicKey = await crypto.subtle.importKey("spki", publicBytes, algorithm, true, ["verify"]);
  const privateKey = await crypto.subtle.importKey("pkcs8", pemBytes(env.BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM, "PRIVATE KEY"), algorithm, false, ["sign"]);
  return { publicKey, privateKey, keyId: await boundLeaseKeyId(publicKey) };
}
