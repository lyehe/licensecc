#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import {
  CapacityHarnessError,
  buildEvidence,
  parseArgs,
  runCapacity,
} from "./public-verifier-capacity-lib.mjs";

function usage() {
  return `usage:
  node scripts/public-verifier-capacity.mjs \\
    --mode <burst|soak|rehearsal> --url <verifier-url> \\
    --peak-rps <P> --max-concurrency <count> \\
    --fingerprint <64-hex> [--project DEFAULT] [--feature DEFAULT] \\
    [--device-hash <64-hex>] [--timeout-ms 10000] \\
    [--duration-seconds <seconds>] [--expected-result <allow|deny|rate-limit>] \\
    [--environment <label>] [--commit-sha <40-hex>]

Acceptance modes are fixed to representative allowed verification traffic:
burst applies 2P for at least 30 minutes; soak applies P for at least four
hours. They require an environment label and exact commit SHA. Rehearsal is
explicitly non-promotable and is capped at 60 seconds. Output is one redacted
JSON evidence document. Sensitive input may be supplied through the
LICENSECC_CAPACITY_* environment variables. The public /v1/verify route does
not use account-token Authorization. Hardened verifier requests may use
LICENSECC_CAPACITY_DEVICE_PRIVATE_KEY_PKCS8_PEM together with
LICENSECC_CAPACITY_DEVICE_KEY_ID.`;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  try {
    const spec = parseArgs(argv, env);
    const run = await runCapacity(spec);
    const evidence = buildEvidence(spec, run);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    return evidence.failures.length === 0 ? 0 : 1;
  } catch (error) {
    const code = error instanceof CapacityHarnessError ? error.message : "capacity_harness_failed";
    process.stderr.write(`${code}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}

export { main, usage };
