import { boundDeviceConfig, loadBoundSigner } from "./bound_config.mjs";
import { sealBoundApproval, openBoundApproval } from "./bound_approval_crypto.mjs";
import { parseGlobalRateLimit } from "./bound_rate.mjs";

/**
 * @typedef {{ registry: boolean, signing_key_pair: boolean, approval_key_ring: boolean, global_rate_limit: boolean }} BoundReadinessChecks
 * @typedef {{ ready: boolean, checks: BoundReadinessChecks }} BoundReadiness
 */

// /health is unauthenticated and this check signs with RSA-3072, so the result is
// memoised per env object. In module Workers the env object is stable for the
// life of an isolate, so the check runs once per isolate; each test builds a fresh
// env, so tests never share a cached result.
/** @type {WeakMap<object, Promise<BoundReadiness>>} */
const readinessByEnv = new WeakMap();

/**
 * Proves locally that the protected device-bound configuration can serve: the
 * client registry parses, the dedicated RSA-3072 signer pair signs and verifies,
 * the approval key ring seals and opens, and BOUND_GLOBAL_RATE_LIMIT is valid.
 * It never issues or renews a lease and never reports configuration values.
 * @param {any} env
 * @returns {Promise<BoundReadiness>}
 */
export async function boundDeviceReadiness(env) {
  if (env === null || typeof env !== "object") return evaluate({});
  let readiness = readinessByEnv.get(env);
  if (readiness === undefined) {
    readiness = evaluate(env);
    readinessByEnv.set(env, readiness);
  }
  return readiness;
}

/**
 * @param {any} env
 * @returns {Promise<BoundReadiness>}
 */
async function evaluate(env) {
  const checks = { registry: false, signing_key_pair: false, approval_key_ring: false, global_rate_limit: false };
  try {
    // Independent of the registry/signer/key-ring chain below: an operator can
    // set an invalid BOUND_GLOBAL_RATE_LIMIT even when everything else is fine,
    // and the runtime clamp would otherwise hide it by silently using the
    // default. Unset parses to the default, so only "set but invalid" fails.
    checks.global_rate_limit = parseGlobalRateLimit(env.BOUND_GLOBAL_RATE_LIMIT) !== null;
    boundDeviceConfig(env);
    checks.registry = true;
    const signer = await loadBoundSigner(env);
    const algorithm = /** @type {CryptoKeyRsaKeyAlgorithm} */ (signer.privateKey.algorithm);
    if (algorithm.modulusLength !== 3072) throw new Error();
    const challenge = new TextEncoder().encode("licensecc-protected-readiness-v1:" + crypto.randomUUID());
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer.privateKey, challenge);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", signer.publicKey, signature, challenge)) throw new Error();
    checks.signing_key_pair = true;
    const probe = { readiness: crypto.randomUUID() }, hash = "0".repeat(64);
    const sealed = await sealBoundApproval(probe, hash, 1, env.BOUND_APPROVAL_ENCRYPTION_KEYS);
    const opened = await openBoundApproval(sealed, hash, 1, env.BOUND_APPROVAL_ENCRYPTION_KEYS);
    if (opened.readiness !== probe.readiness) throw new Error();
    checks.approval_key_ring = true;
  } catch { /* Never serialize parser/crypto errors containing supplied material. */ }
  return Object.freeze({ ready: Object.values(checks).every(Boolean), checks: Object.freeze(checks) });
}
