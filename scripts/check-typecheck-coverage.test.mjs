import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");

function fixtureRepository(t) {
  const root = mkdtempSync(join(tmpdir(), "licensecc-typecheck-coverage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "config", "core.autocrlf", "false"]);
  const candidates = execFileSync("git", ["-C", repositoryRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "packages", "services"], { encoding: "utf8" }).split("\0");
  const inputs = [...new Set(candidates)].filter(file => /\/(?:tsconfig(?:\.[^.]+)*|package)\.json$/.test(file) && existsSync(join(repositoryRoot, file)));
  inputs.push("scripts/check-typecheck-coverage.mjs", "scripts/ci/git-files.mjs");
  for (const file of inputs) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(repositoryRoot, file), join(root, file));
  }
  execFileSync("git", ["-C", root, "add", "."]);
  return root;
}

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function check(root) {
  return spawnSync(process.execPath, [join(root, "scripts/check-typecheck-coverage.mjs")], { encoding: "utf8" });
}

test("coverage checks untracked production JavaScript and tolerates removed cached source", t => {
  const root = fixtureRepository(t);
  const removed = "packages/licensing-domain/src/removed.mjs";
  write(root, removed, "export const old = 1;\n");
  execFileSync("git", ["-C", root, "add", removed]);
  unlinkSync(join(root, removed));
  const clean = check(root);
  assert.equal(clean.status, 0, clean.stderr);

  write(root, "services/unreviewed/src/new.mjs", "export const value = 1;\n");
  const unreviewed = check(root);
  assert.equal(unreviewed.status, 1);
  assert.match(unreviewed.stderr, /new\.mjs is production JavaScript outside the reviewed checkJs roots/u);
  assert.doesNotMatch(unreviewed.stderr, /ENOENT/u);
});

test("new mixed JavaScript graphs must retain strict implicit-any checking", t => {
  const root = fixtureRepository(t);
  const path = "services/strict-example/tsconfig.json";
  write(root, path, JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, strict: true } }));
  const strict = check(root);
  assert.equal(strict.status, 0, strict.stderr);

  write(root, path, JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, strict: true, noImplicitAny: false } }));
  const weakened = check(root);
  assert.equal(weakened.status, 1);
  assert.match(weakened.stderr, /new JavaScript graph without strict implicit-any checking/u);
});

test("relocated adapters cannot broaden the legacy exception or bypass checking in build scripts", t => {
  const root = fixtureRepository(t);
  const configPath = "services/cloudflare-license-admin/tsconfig.adapters.json";
  const manifestPath = "services/cloudflare-license-admin/package.json";
  write(root, configPath, JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, noImplicitAny: false }, include: ["src/**/*.mjs"] }));
  const broad = check(root);
  assert.equal(broad.status, 1);
  assert.match(broad.stderr, /include exactly the reviewed relocated admin adapters/u);

  copyFileSync(join(repositoryRoot, configPath), join(root, configPath));
  write(root, manifestPath, JSON.stringify({ scripts: { "build:worker": "npm run generate:wrangler-types && tsc -p tsconfig.worker.json", typecheck: "tsc -p tsconfig.worker.typecheck.json" } }));
  const unchecked = check(root);
  assert.equal(unchecked.status, 1);
  assert.match(unchecked.stderr, /must check the relocated JavaScript adapters/u);
});
