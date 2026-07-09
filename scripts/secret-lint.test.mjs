import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
// This test plants one file carrying all three secret shapes into a throwaway
// directory, then runs EACH service's real `scripts/lint.mjs` entrypoint with
// that directory as its scan root (cwd) and asserts the entrypoint fails AND
// names each secret shape. Against the pre-fix admin scanner this file would
// have passed clean (exit 0), so the assertions below are a true RED->GREEN
// guard on the union floor.
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

function runWrapper(service, cwd) {
  const wrapper = join(REPO_ROOT, "services", service, "scripts", "lint.mjs");
  return spawnSync(process.execPath, [wrapper], {
    cwd,
    encoding: "utf8",
  });
}

for (const service of SERVICES) {
  test(`union scanner flags PEM + JWT + api-token for ${service}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-lint-"));
    try {
      writeFileSync(join(dir, "planted-secret.ts"), PLANTED);
      const res = runWrapper(service, dir);
      const combined = `${res.stdout}\n${res.stderr}`;
      assert.notEqual(
        res.status,
        0,
        `${service} lint must fail on planted secrets; got exit ${res.status}\n${combined}`,
      );
      // "flags each": the PEM header, the JWT (its regex needle source contains
      // the segment quantifier "{40,}"), and the API-token assignment.
      assert.match(combined, /BEGIN PRIVATE KEY/, `${service}: PEM not flagged\n${combined}`);
      assert.match(combined, /\{40,\}/, `${service}: JWT not flagged\n${combined}`);
      assert.match(combined, /CLOUDFLARE_API_TOKEN=/, `${service}: api-token not flagged\n${combined}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("union scanner passes a clean tree (no false positive)", () => {
  const dir = mkdtempSync(join(tmpdir(), "secret-lint-clean-"));
  try {
    writeFileSync(join(dir, "benign.ts"), "export const answer = 42;\n");
    // Admin carries the SIGNING_KEY_NEEDLES extras on top of the base union;
    // a benign file must still pass so the gate is not vacuously red.
    const res = runWrapper("cloudflare-license-admin", dir);
    assert.equal(res.status, 0, `clean tree should pass; got exit ${res.status}\n${res.stdout}\n${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
