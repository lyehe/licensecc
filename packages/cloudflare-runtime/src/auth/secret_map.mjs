// Stateless, fail-closed key-map decoding for Worker bindings. No decoded secret
// is retained at module scope: callers load it from their own request/event Env.

const MIN_SECRET_BYTES = 32;

export function bytesFromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function loadSecretMap(rawJson) {
  if (typeof rawJson !== "string" || rawJson.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const map = Object.create(null);
  let count = 0;
  for (const keyId of Object.keys(parsed)) {
    const value = parsed[keyId];
    if (typeof value !== "string" || value.length === 0) return null;
    let secretBytes;
    try {
      secretBytes = bytesFromBase64(value);
    } catch {
      return null;
    }
    if (secretBytes.length < MIN_SECRET_BYTES) return null;
    map[keyId] = secretBytes;
    count += 1;
  }
  return count === 0 ? null : map;
}

export function lookupSecret(map, keyId) {
  if (!Object.prototype.hasOwnProperty.call(map, keyId)) return null;
  const value = map[keyId];
  return value instanceof Uint8Array ? value : null;
}
