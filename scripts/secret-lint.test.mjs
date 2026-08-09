import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findSecretNeedles, listTrackedFiles } from "./secret-lint.mjs";

// ---------------------------------------------------------------------------
// Finding-12 regression guard for the shared union secret scanner.
//
// The bug: the four per-service `scripts/lint.mjs` copies had drifted, and the
// admin copy only checked three env-var-NAME needles. A pasted
// `BEGIN PRIVATE KEY` block, a committed JWT, or a `CLOUDFLARE_API_TOKEN=<value>`
// assignment therefore sailed through `npm run lint:services` for admin. The fix
// routes every service through repo-root `scripts/secret-lint.mjs`, whose
// BASE_NEEDLES union flags all three across ALL FOUR services.
//
// The scanner intentionally examines Git-tracked files only.  The first two
// tests exercise the content floor and tracked-file selection separately; the
// final loop executes each real service entry point over its tracked service
// tree.  No test relies on an untracked workspace file being scanned.
// ---------------------------------------------------------------------------

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const SERVICES = [
  "cloudflare-licensing-backend",
  "cloudflare-license-admin",
  "cloudflare-customer-portal",
  "cloudflare-d1-backup",
];

// A file carrying all three universally-forbidden secret shapes at once.
const PEM_MARKER = "BEGIN PRIVATE KEY";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9AAAAAAAAAA" +
  ".eyJzdWIiOiIxMjM0NTY3ODkwIn0AAAAAAA" +
  ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const TOKEN_ASSIGNMENT = "CLOUDFLARE_API_TOKEN=deadbeefdeadbeefdeadbeefdeadbeef";
const PLANTED = [
  "-----" + PEM_MARKER + "-----",
  "const jwt = \"" + JWT + "\";",
  TOKEN_ASSIGNMENT,
  "-----END PRIVATE KEY-----",
].join("\n");

function runWrapper(service, cwd = join(REPO_ROOT, "services", service)) {
  const wrapper = join(REPO_ROOT, "services", service, "scripts", "lint.mjs");
  return spawnSync(process.execPath, [wrapper], {
    cwd,
    encoding: "utf8",
  });
}

function makeTrackedFixture({ trackedContent, untrackedContent = undefined }) {
  const dir = mkdtempSync(join(tmpdir(), "secret-lint-fixture-"));
  writeFileSync(join(dir, "tracked.ts"), trackedContent);
  if (untrackedContent !== undefined) {
    writeFileSync(join(dir, "untracked.ts"), untrackedContent);
  }
  const init = spawnSync("git", ["init", "--quiet"], { cwd: dir, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const add = spawnSync("git", ["add", "tracked.ts"], { cwd: dir, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  return dir;
}

test("union scanner recognizes PEM, JWT, and API-token assignment markers", () => {
  const hits = findSecretNeedles(PLANTED, [PEM_MARKER, /[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, TOKEN_ASSIGNMENT]);
  assert.equal(hits.length, 3);
});

test("scanner selects only Git-tracked files", () => {
  const dir = makeTrackedFixture({ trackedContent: "export const safe = true;\n", untrackedContent: PLANTED });
  try {
    const tracked = listTrackedFiles(dir).map((file) => file.replace(/\\/g, "/"));
    assert.deepEqual(tracked.map((file) => file.split("/").at(-1)), ["tracked.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanner tolerates a locally deleted tracked file", () => {
  const dir = makeTrackedFixture({ trackedContent: "export const safe = true;\n" });
  try {
    rmSync(join(dir, "tracked.ts"));
    assert.deepEqual(listTrackedFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const service of SERVICES) {
  test(`real ${service} scanner rejects tracked PEM + JWT + API token`, () => {
    const dir = makeTrackedFixture({ trackedContent: PLANTED });
    try {
      const res = runWrapper(service, dir);
      const combined = `${res.stdout}\n${res.stderr}`;
      assert.notEqual(res.status, 0, `${service} scan must reject a tracked secret\n${combined}`);
      assert.match(combined, /BEGIN PRIVATE KEY/, `${service}: PEM marker was not rejected\n${combined}`);
      assert.match(combined, /\{40,\}/, `${service}: JWT marker was not rejected\n${combined}`);
      assert.match(combined, /CLOUDFLARE_API_TOKEN=/, `${service}: token marker was not rejected\n${combined}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`tracked union scanner passes ${service}`, () => {
    const res = runWrapper(service);
    assert.equal(res.status, 0, `clean tree should pass; got exit ${res.status}\n${res.stdout}\n${res.stderr}`);
  });
}

test("real service wrapper ignores an untracked secret", () => {
  const dir = makeTrackedFixture({ trackedContent: "export const safe = true;\n", untrackedContent: PLANTED });
  try {
    const res = runWrapper("cloudflare-license-admin", dir);
    assert.equal(res.status, 0, `untracked file must not affect committed scan\n${res.stdout}\n${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repository entrypoint scans the tracked superproject", () => {
  const entrypoint = join(REPO_ROOT, "scripts", "scan-secrets.mjs");
  const res = spawnSync(process.execPath, [entrypoint], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(res.status, 0, `repository scan should pass\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /scan:secrets ok/, "repository entrypoint did not invoke the tracked scanner");
});
