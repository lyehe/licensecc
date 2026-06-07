import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REQUIRED_IGNORED_PATHS,
  SECRET_ENV_NAMES,
  isPlaceholderValue,
  scanText,
} from "./secret_hygiene_scan.mjs";

test("secret hygiene scan defines required ignored deployment files", () => {
  assert.equal(REQUIRED_IGNORED_PATHS.includes("services/cloudflare-online-verifier/wrangler.toml"), true);
  assert.equal(REQUIRED_IGNORED_PATHS.includes("services/cloudflare-d1-backup/wrangler.jsonc"), true);
});

test("secret hygiene scan exports release secret environment names", () => {
  assert.equal(SECRET_ENV_NAMES.includes("LICENSECC_ACCESS_JWT"), true);
  assert.equal(SECRET_ENV_NAMES.includes("LICENSECC_NON_ADMIN_ACCESS_JWT"), true);
  assert.equal(SECRET_ENV_NAMES.includes("CLOUDFLARE_API_TOKEN"), true);
  assert.equal(SECRET_ENV_NAMES.includes("D1_REST_API_TOKEN"), true);
  assert.equal(SECRET_ENV_NAMES.includes("ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM"), true);
});

test("secret hygiene scan permits documented placeholders", () => {
  assert.equal(isPlaceholderValue("<redacted>"), true);
  assert.equal(isPlaceholderValue("replace-with-token"), true);
  assert.equal(isPlaceholderValue("sync-secret"), true);
});

test("secret hygiene scan flags private key markers", () => {
  const marker = "-----BEGIN " + "PRIVATE KEY-----";
  const findings = scanText("fixture.txt", `${marker}\nabc`);
  assert.deepEqual(findings.map((finding) => finding.kind), ["private_key_marker"]);
});

test("secret hygiene scan flags JWT-like tokens", () => {
  const token = `${"a".repeat(40)}.${"b".repeat(20)}.${"c".repeat(20)}`;
  const findings = scanText("fixture.txt", `token=${token}`);
  assert.deepEqual(findings.map((finding) => finding.kind), ["jwt_like_token"]);
});

test("secret hygiene scan flags real-looking secret assignments but not placeholders", () => {
  assert.equal(scanText("fixture.txt", "CLOUDFLARE_API_TOKEN=<redacted>").length, 0);
  assert.equal(scanText("fixture.txt", "if (env.SYNC_API_TOKEN === undefined) return;").length, 0);
  assert.equal(scanText("fixture.txt", "grep -E 'CLOUDFLARE_API_TOKEN=|TOKEN='").length, 0);
  assert.equal(scanText("fixture.txt", "process.env.LICENSECC_ACCESS_JWT = originalJwt;").length, 0);
  const findings = scanText("fixture.txt", "CLOUDFLARE_API_TOKEN=abcdefghijklmnopqrstuvwxyz123456");
  assert.deepEqual(findings.map((finding) => finding.kind), ["secret_assignment"]);
  assert.equal(findings[0].name, "CLOUDFLARE_API_TOKEN");
});
