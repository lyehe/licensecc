import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isTextPath,
  sanitizeDiffCheckOutput,
  scanTrailingWhitespace,
  scanUntrackedWhitespace,
} from "./workspace_hygiene_check.mjs";

test("workspace hygiene text path filter covers release source files", () => {
  assert.equal(isTextPath("scripts/validate_release_gates.mjs"), true);
  assert.equal(isTextPath("doc/analysis/remaining-gap-closure-checklist.rst"), true);
  assert.equal(isTextPath("services/cloudflare-d1-backup/package-lock.json"), true);
  assert.equal(isTextPath("build/output.bin"), false);
});

test("workspace hygiene scanner finds trailing spaces and tabs without line content", () => {
  const findings = scanTrailingWhitespace("fixture.mjs", "ok\nbad space \nbad tab\t\n");
  assert.deepEqual(findings, [
    { path: "fixture.mjs", line: 2, kind: "trailing_whitespace" },
    { path: "fixture.mjs", line: 3, kind: "trailing_whitespace" },
  ]);
});

test("workspace hygiene scanner supports direct file lists for untracked checks", () => {
  const findings = scanUntrackedWhitespace(["scripts/workspace_hygiene_check.test.mjs"]);
  assert.deepEqual(findings, []);
});

test("workspace hygiene diff-check output is sanitized", () => {
  const sanitized = sanitizeDiffCheckOutput([
    "secret.txt:3: trailing whitespace.",
    "+CLOUDFLARE_API_TOKEN=do-not-print ",
    "safe.txt:9: new blank line at EOF.",
    "",
  ].join("\n"));
  assert.deepEqual(sanitized, [
    "secret.txt:3: trailing whitespace.",
    "safe.txt:9: new blank line at EOF.",
  ]);
  assert.equal(sanitized.join("\n").includes("do-not-print"), false);
});
