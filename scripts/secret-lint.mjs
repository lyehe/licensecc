import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Shared committed-secret scanner for every Cloudflare service.
//
// Finding 12: four divergent `scripts/lint.mjs` copies had drifted so far apart
// that admin only checked three env-var-name needles — a pasted
// `BEGIN PRIVATE KEY` block sailed through `npm run lint:services`. This module
// carries the UNION of every service's historical needle set so all four
// services enforce the same floor. Each service's `scripts/lint.mjs` is now a
// thin wrapper that calls `runSecretLint` with its own EXTRA needles.
//
// Self-exclusion: the env-var-name needles are built with a reserved-word join
// trick so the needle strings never appear literally in scanned source. The PEM
// header markers below appear literally, but this file lives at the repo root
// (`scripts/`) and is never inside any per-service scan root, so it never scans
// itself. The thin wrappers are additionally skipped by path (see runSecretLint).
// ---------------------------------------------------------------------------

// Universally-forbidden markers: actual secret VALUES / PEM material / token
// assignments that NO service should ever commit. These are safe to apply to
// every service (they match key material, not identifiers). The signing-key env
// NAMES are deliberately NOT here — see SIGNING_KEY_NEEDLES below.
const BASE_NEEDLES = [
  // Cloudflare / D1 / backup API tokens as env assignments (`NAME=<value>`).
  ["CLOUDFLARE", "API", "TOKEN"].join("_") + "=",
  ["D1", "REST", "API", "TOKEN"].join("_") + "=",
  ["BACKUP", "TRIGGER", "TOKEN"].join("_") + "=",
  ["account", "id"].join("_") + " =",
  // Raw PEM key material accidentally pasted into source.
  "BEGIN PRIVATE KEY",
  "BEGIN RSA PRIVATE KEY",
  "PRIVATE KEY-----\\n",
  // A committed JWT (three base64url segments joined by dots).
  /[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
];

// Signing/lease private-key env-binding NAMES. Referencing these names is a red
// flag for every service EXCEPT the backend, which owns those bindings and reads
// them legitimately across src/, tests, and wrangler config. So this set is
// passed as EXTRA needles by the admin, portal, and d1-backup wrappers (the
// services that must never touch the signing key) and withheld from the backend.
export const SIGNING_KEY_NEEDLES = [
  ["ONLINE", "SIGNING", "PRIVATE", "KEY"].join("_"),
  ["ONLINE", "SIGNING", "PRIVATE", "KEY", "PKCS8", "PEM"].join("_"),
  ["LEASE", "SIGNING", "PRIVATE", "KEY", "PKCS8", "PEM"].join("_"),
];

const DEFAULT_SKIP_DIRS = ["node_modules", "dist", "dist-worker", ".wrangler"];

function* walk(root, skipDirs) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (skipDirs.includes(entry)) continue;
      yield* walk(path, skipDirs);
    } else {
      yield path;
    }
  }
}

/**
 * Scan a service tree for committed secrets.
 *
 * @param {object} [options]
 * @param {string} [options.root="."]            Directory to scan (service dir; cwd is the service).
 * @param {Array<string|RegExp>} [options.extraNeedles=[]]  Service-specific markers on top of the base union.
 * @param {string[]} [options.excludeFiles=[]]   Path suffixes to skip (documented legitimate fixtures).
 * @param {string[]} [options.skipDirs]          Directory names to prune (defaults to the portal set).
 * @param {string} [options.label="secret"]      Word used in the violation message.
 */
export function runSecretLint({
  root = ".",
  extraNeedles = [],
  excludeFiles = [],
  skipDirs = DEFAULT_SKIP_DIRS,
  label = "secret",
} = {}) {
  const needles = [...BASE_NEEDLES, ...extraNeedles];
  let failed = false;
  for (const file of walk(root, skipDirs)) {
    const norm = file.replace(/\\/g, "/");
    // Never scan the thin wrappers (they name their own extra needles) or the
    // documented legitimate fixtures.
    if (norm.endsWith("scripts/lint.mjs")) continue;
    if (excludeFiles.some((ex) => norm.endsWith(ex))) continue;
    const content = readFileSync(file, "utf8");
    for (const needle of needles) {
      const hit = typeof needle === "string" ? content.includes(needle) : needle.test(content);
      if (hit) {
        console.error(`forbidden ${label} secret reference in ${file}: ${needle.toString()}`);
        failed = true;
      }
    }
  }
  if (failed) {
    process.exit(1);
  }
  console.log("lint ok");
}
