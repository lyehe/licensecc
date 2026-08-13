import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
function parseCodeowners(source) {
  const entries = new Map();
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/u);
    assert.ok(!entries.has(pattern), `.github/CODEOWNERS duplicates ${pattern} on line ${index + 1}`);
    entries.set(pattern, owners);
  }
  return entries;
}

test("CODEOWNERS has one confirmed repository-wide fallback", () => {
  const entries = parseCodeowners(readFileSync(resolve(repositoryRoot, ".github/CODEOWNERS"), "utf8"));
  assert.deepEqual([...entries.keys()], ["*"], "path-specific rules add no behavior until distinct teams are confirmed");
  const owners = entries.get("*");
  assert.equal(owners.length, 1, "the repository needs one unambiguous review fallback");
  assert.match(owners[0], /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u, "fallback has an invalid GitHub owner");
  assert.doesNotMatch(owners[0], /(?:todo|placeholder|example|unknown)/iu);
});

test("ownership documentation declares the executable CODEOWNERS relationship", () => {
  const ownership = readFileSync(resolve(repositoryRoot, "doc/architecture/ownership.md"), "utf8");
  assert.match(ownership, /\.github\/CODEOWNERS/u);
  assert.match(ownership, /repository-wide review fallback/u);
  assert.match(ownership, /role-specific GitHub teams/u);
});
