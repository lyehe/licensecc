#!/usr/bin/env node
import { readFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { boundDeviceReadiness } from "../src/device/bound_readiness.mjs";

// This validates material prepared for deployment with the same check the
// deployed /health runs. It cannot prove which values are deployed or that an
// actual entitlement can be issued/renewed remotely.
export async function checkProtectedDeviceConfiguration(env) {
  const { ready, checks } = await boundDeviceReadiness(env);
  return { schema_version: "licensecc.protected-device-configuration.v1",
    ok: ready, checks: { ...checks }, scope: "local_configuration_only",
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
