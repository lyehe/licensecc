// The protected device-bound configuration a deployed backend needs before its
// health reports protected readiness: registry, dedicated RSA-3072 signer pair
// and approval encryption key ring. Every call generates a fresh signer. This
// fixture is intentionally scoped to ONLY the protected-device fields: a test that
// iterates its keys (protected-device-readiness.test.mjs) relies on each one being
// required for protected_device_ready. Order-ingest/config-consistency fixtures
// (ORDER_SIGNER_SCOPES, the edge rate limiters) are a separate, unrelated concern
// and are added on top of this by whichever test needs a warning-free /health.
const algorithm = { name: "RSASSA-PKCS1-v1_5", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const pem = (label, bytes) => `-----BEGIN ${label}-----\n${Buffer.from(bytes).toString("base64")}\n-----END ${label}-----`;

export async function protectedDeviceEnv() {
  const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  return {
    BOUND_DEVICE_CONFIG: JSON.stringify({
      issuer: "https://licenses.example.test/",
      audience: "desktop",
      authorization_url: "https://portal.example.test/connect",
      clients: [{ client_id: "desktop", project: "APP", display_name: "Example", callbacks: [{ host: "127.0.0.1", path: "/callback" }] }],
    }),
    BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", keys.privateKey)),
    BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", keys.publicKey)),
    BOUND_APPROVAL_ENCRYPTION_KEYS: JSON.stringify({ active: "a1", keys: { a1: Buffer.alloc(32, 7).toString("base64url") } }),
  };
}

// A names-only baseline that keeps /health's config-consistency check warning-free:
// a valid ORDER_SIGNER_SCOPES map and both edge rate-limiter bindings. Spread this on
// top of protectedDeviceEnv() (never in place of it) for a fully warning-free /health;
// a test exercising one specific missing-config warning removes just that one field.
const fakeRateLimiter = () => ({ limit: async () => ({ success: true }) });

export function configConsistencyCleanEnv() {
  return {
    ORDER_SIGNER_SCOPES: JSON.stringify({ "test-order-key": { project: "DEFAULT" } }),
    BOUND_REGISTRATION_RATE_LIMITER: fakeRateLimiter(),
    BOUND_SESSION_RATE_LIMITER: fakeRateLimiter(),
  };
}
