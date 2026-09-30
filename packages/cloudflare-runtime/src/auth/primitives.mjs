const textEncoder = new TextEncoder();

export async function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const keyBytes = new Uint8Array(32);
  crypto.getRandomValues(keyBytes);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const macA = new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(a)));
  const macB = new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(b)));
  let diff = 0;
  for (let index = 0; index < macA.length; index += 1) {
    const left = macA[index];
    const right = macB[index];
    if (left === undefined || right === undefined) return false;
    diff |= left ^ right;
  }
  return diff === 0;
}
