#!/usr/bin/env node
import { readFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { boundDeviceConfig, loadBoundSigner } from "../src/device/bound_config.mjs";
import { sealBoundApproval, openBoundApproval } from "../src/device/bound_approval_crypto.mjs";
import { parseGlobalRateLimit } from "../src/device/bound_rate.mjs";

// This validates material prepared for deployment. It cannot prove which values
// are deployed or that an actual entitlement can be issued/renewed remotely.
export async function checkProtectedDeviceConfiguration(env) {
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
    if (signer.privateKey.algorithm.modulusLength !== 3072) throw new Error();
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
  return { schema_version: "licensecc.protected-device-configuration.v1",
    ok: Object.values(checks).every(Boolean), checks, scope: "local_configuration_only",
    live_issuance: "not_run", live_renewal: "not_run" };
}
async function boundedJson(path) {
  const file = resolve(path), metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 131072) throw new Error();
  const value = JSON.parse(await readFile(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value;
}
export async function main(argv) {
  try {
    const [configArg, secretsArg, envArg, ...rest] = argv;
    if (rest.length || !configArg?.startsWith("--config=") || !secretsArg?.startsWith("--secrets=") || (envArg !== undefined && !envArg.startsWith("--env="))) throw new Error();
    const config = await boundedJson(configArg.slice(9));
    const secrets = await boundedJson(secretsArg.slice(10));
    const name = envArg?.slice(6);
    // Wrangler env blocks do not inherit top-level vars; validate exactly what that environment deploys.
    const vars = name === undefined ? config.vars : config.env?.[name]?.vars;
    if (!vars || typeof vars !== "object") throw new Error();
    const result = await checkProtectedDeviceConfiguration({ ...vars, ...secrets });
    process.stdout.write(JSON.stringify(result) + "\n");
    return result.ok ? 0 : 1;
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: "protected_configuration_unavailable" }) + "\n");
    return 1;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));
