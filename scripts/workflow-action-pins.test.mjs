import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fullSha = /^[0-9a-f]{40}$/i;
const usesLine = /^\s*(?:-\s*)?uses:\s*(\S+?)(?:\s+#\s*(.*?))?\s*$/gm;

function trackedWorkflowPaths() {
  return execFileSync("git", ["ls-files", "--", ".github/workflows"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter((path) => /\.ya?ml$/i.test(path));
}

function source(relativePath) {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

function workflowJobLines(relativePath, jobName) {
  const lines = source(relativePath).split(/\r?\n/);
  const start = lines.indexOf(`  ${jobName}:`);
  assert.ok(start >= 0, `${relativePath}: missing ${jobName} job`);

  const end = lines.findIndex((line, index) => {
    if (index <= start) return false;
    const indentation = line.length - line.trimStart().length;
    return indentation === 2 && line.trimEnd().endsWith(":");
  });
  return lines.slice(start, end === -1 ? lines.length : end);
}

function workflowReferences() {
  return trackedWorkflowPaths().flatMap((path) => {
    const content = source(path);
    return [...content.matchAll(usesLine)].map((match) => ({
      path,
      reference: match[1],
      comment: match[2]?.trim() ?? "",
    }));
  });
}

test("all non-local action and Docker uses references are immutable", () => {
  const references = workflowReferences();
  assert.ok(references.length > 0, "expected at least one workflow uses reference");

  for (const { path, reference, comment } of references) {
    if (reference.startsWith("./")) continue;

    const at = reference.lastIndexOf("@");
    assert.ok(at > 0, `${path}: non-local uses reference must include @<sha>`);
    assert.ok(fullSha.test(reference.slice(at + 1)), `${path}: ${reference} is not pinned to a full 40-hex SHA`);
    assert.match(comment, /^v\d+(?:\.\d+(?:\.\d+)?)?$/i, `${path}: ${reference} needs an inline version comment`);
  }
});

test("Dependabot keeps GitHub Actions SHA pins maintainable", () => {
  const dependabot = source(".github/dependabot.yml");
  assert.match(dependabot, /^version:\s*2\s*$/m);
  assert.match(dependabot, /package-ecosystem:\s*github-actions/);
  assert.match(dependabot, /directory:\s*["']?\/["']?/);
  assert.match(dependabot, /schedule:\s*\r?\n\s+interval:\s*weekly/);
});

test("lint repository-quality runs the clean-checkout regression gate", () => {
  const jobLines = workflowJobLines(".github/workflows/lint.yml", "repository-quality");
  assert.equal(
    jobLines.filter((line) => line.trim() === "npm run test:capabilities").length,
    1,
    "repository-quality must invoke test:capabilities exactly once",
  );
  assert.equal(
    jobLines.filter((line) => line.trim() === "npm run test:clean-checkout").length,
    1,
    "repository-quality must invoke test:clean-checkout exactly once",
  );
  assert.equal(
    jobLines.filter((line) => line.trim() === "npm run test:versions").length,
    1,
    "repository-quality must invoke test:versions exactly once",
  );
  assert.equal(
    jobLines.filter((line) => line.trim() === "npm run check:versions").length,
    1,
    "repository-quality must invoke check:versions exactly once",
  );
});

test("capability evidence remains a PR gate locally and in repository-quality", () => {
  const packageJson = JSON.parse(source("package.json"));
  assert.match(packageJson.scripts["check:pr"], /npm run test:capabilities/);
  assert.match(packageJson.scripts["check:pr"], /npm run check:capabilities/);
  assert.equal(packageJson.scripts["test:capabilities"], "node --test scripts/check-capability-registry.test.mjs");
  assert.equal(packageJson.scripts["check:capabilities"], "node scripts/check-capability-registry.mjs");

  const jobLines = workflowJobLines(".github/workflows/lint.yml", "repository-quality");
  assert.equal(
    jobLines.filter((line) => line.trim() === "npm run check:capabilities").length,
    1,
    "repository-quality must invoke check:capabilities exactly once",
  );
});
