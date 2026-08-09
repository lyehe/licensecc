import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

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
// header markers below appear literally, so the repository-level entry point
// excludes this implementation and its deliberately adversarial unit fixture by
// exact path. All other tracked source, including the service wrappers, is read.
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

/**
 * Return the existing files Git tracks below a scanner root. This intentionally
 * never walks the working tree: an untracked fixture, local secret, generated
 * output, or a stale node_modules directory must never become scanner input.
 * A locally deleted tracked path is skipped rather than turning a scan into an
 * I/O error; there is no source file left in the checkout to inspect.
 *
 * Git emits paths relative to the `-C` directory, including when that directory
 * is a service nested inside the monorepo.  Resolve those paths here so callers
 * can safely read them regardless of their current working directory.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function listTrackedFiles(root) {
  const absoluteRoot = resolve(root);
  let output;
  try {
    output = execFileSync("git", ["-C", absoluteRoot, "ls-files", "-z", "--", "."], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`scan:secrets requires a Git worktree at ${absoluteRoot}: ${detail}`);
  }

  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((relativePath) => join(absoluteRoot, relativePath))
    .filter((file) => existsSync(file));
}

/**
 * Find forbidden marker occurrences in a supplied source string.  Keeping this
 * pure makes the scanner's security floor directly testable without creating
 * workspace files that the production command must deliberately ignore.
 *
 * @param {string} content
 * @param {Array<string|RegExp>} needles
 * @returns {Array<string|RegExp>}
 */
export function findSecretNeedles(content, needles) {
  return needles.filter((needle) =>
    typeof needle === "string" ? content.includes(needle) : needle.test(content),
  );
}

/**
 * Scan a service tree for committed secrets.
 *
 * @param {object} [options]
 * @param {string} [options.root="."]            Git worktree directory to scan (service cwd).
 * @param {Array<string|RegExp>} [options.extraNeedles=[]]  Service-specific markers on top of the base union.
 * @param {string[]} [options.excludeFiles=[]]   Path suffixes to skip (documented legitimate fixtures).
 * @param {string} [options.label="secret"]      Word used in the violation message.
 */
export function runSecretLint({
  root = ".",
  extraNeedles = [],
  excludeFiles = [],
  label = "secret",
} = {}) {
  const needles = [...BASE_NEEDLES, ...extraNeedles];
  let failed = false;
  for (const file of listTrackedFiles(root)) {
    // Git lists submodule gitlinks too.  They are tracked repository entries,
    // but not files belonging to this scanner's worktree and must never be
    // descended into or read as part of the superproject scan.
    if (statSync(file).isDirectory()) continue;
    const norm = file.replace(/\\/g, "/");
    // Skip only documented, path-specific legitimate fixtures.
    if (excludeFiles.some((ex) => norm.endsWith(ex))) continue;
    const content = readFileSync(file, "utf8");
    for (const needle of findSecretNeedles(content, needles)) {
      console.error(`forbidden ${label} secret reference in ${file}: ${needle.toString()}`);
      failed = true;
    }
  }
  if (failed) {
    process.exit(1);
  }
  console.log("scan:secrets ok");
}
