import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fullSha = /^[0-9a-f]{40}$/iu;

function source(relativePath) {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function dependabotUpdates(content) {
  const lines = content.split(/\r?\n/u);
  const starts = lines.flatMap((line, index) => (/^ {2}- package-ecosystem:/u.test(line) ? [index] : []));
  return starts.map((start, position) => {
    const block = lines.slice(start, starts[position + 1] ?? lines.length).join("\n");
    const ecosystem = /^ {2}- package-ecosystem:\s*([^\s#]+)\s*$/mu.exec(block)?.[1];
    const directory = /^ {4}directory:\s*([^#]+?)\s*$/mu.exec(block)?.[1];
    assert.ok(ecosystem, `Dependabot block at line ${start + 1} needs a package ecosystem`);
    assert.ok(directory, `Dependabot ${ecosystem} block needs a directory`);
    return { ecosystem: unquote(ecosystem), directory: unquote(directory), block };
  });
}

function actionReferences(content) {
  return [...content.matchAll(/^\s*(?:-\s*)?uses:\s*([^@\s]+)@([^\s#]+)(?:\s+#\s*(\S.*))?\s*$/gmu)].map((match) => ({
    action: match[1],
    reference: match[2],
    comment: match[3] ?? "",
  }));
}

test("security policy defines a private, prerelease-accurate reporting contract", () => {
  const policy = source("SECURITY.md");

  assert.match(policy, /has not published a stable platform release/iu);
  assert.match(policy, /does not operate or claim a hosted production service/iu);
  assert.match(policy, /https:\/\/github\.com\/lyehe\/licensecc\/security\/advisories\/new/iu);
  assert.match(policy, /acknowledgment within three business days/iu);
  assert.match(policy, /initial\s+triage decision within seven business days/iu);
  assert.match(policy, /Do not include exploit details,\s+credentials, customer data, license material/iu);
  assert.doesNotMatch(policy, /\b(?:TODO|TBD)\b|security@example\.com/iu);
});

test("Dependabot covers every maintained dependency root without auto-merge", () => {
  const content = source(".github/dependabot.yml");
  const updates = dependabotUpdates(content);
  const actual = updates.map(({ ecosystem, directory }) => `${ecosystem}:${directory}`).sort();
  const expected = [
    "github-actions:/",
    "npm:/",
    "nuget:/sdks/dotnet",
    "pip:/doc",
    "uv:/sdks/python",
    "uv:/services/cloudflare-licensing-backend/scripts/pg-parity",
  ].sort();

  assert.deepEqual(actual, expected);
  for (const { ecosystem, directory, block } of updates) {
    assert.match(block, /^ {4}schedule:\s*\n {6}interval:\s*weekly\s*$/mu, `${ecosystem}:${directory} weekly schedule`);
    assert.match(block, /^ {4}groups:\s*$/mu, `${ecosystem}:${directory} grouped updates`);
    assert.match(block, /^ {10}- ["']\*["']\s*$/mu, `${ecosystem}:${directory} all-dependency group`);
  }
  assert.doesNotMatch(content, /auto-?merge|merge-method/iu);

  for (const relativePath of [
    "package-lock.json",
    "sdks/python/uv.lock",
    "services/cloudflare-licensing-backend/scripts/pg-parity/uv.lock",
    "sdks/dotnet/src/Licensecc.Client/packages.lock.json",
    "doc/requirements.txt",
  ]) {
    assert.equal(existsSync(resolve(repositoryRoot, relativePath)), true, `${relativePath} dependency authority`);
  }
});

test("CodeQL scans JavaScript/TypeScript and the maintained native build path", () => {
  const workflow = source(".github/workflows/codeql.yml");
  const actions = actionReferences(workflow);

  assert.match(workflow, /^ {2}push:\s*\n {4}branches: \[main\]\s*$/mu);
  assert.match(workflow, /^ {2}pull_request:\s*\n {4}branches: \[main\]\s*$/mu);
  assert.match(workflow, /^ {2}schedule:\s*$/mu);
  assert.match(workflow, /^ {2}workflow_dispatch:\s*$/mu);
  assert.match(workflow, /language:\s*javascript-typescript\s*\n\s*build_mode:\s*none/iu);
  assert.match(workflow, /language:\s*c-cpp\s*\n\s*build_mode:\s*manual/iu);
  assert.match(workflow, /scripts\/bootstrap\.ps1 -CheckOnly/iu);
  assert.match(workflow, /scripts\/check-build-purity\.ps1[\s\S]*-Preset ci-linux-core[\s\S]*-SkipTests/iu);
  assert.doesNotMatch(workflow, /codeql-action\/autobuild/iu);
  assert.match(workflow, /persist-credentials:\s*false/iu);
  assert.doesNotMatch(workflow, /^\s+(?:contents|actions|packages|pull-requests):\s*write\s*$/mu);
  assert.equal((workflow.match(/^\s+security-events:\s*write\s*$/gmu) ?? []).length, 1);

  assert.deepEqual(actions.map(({ action }) => action), [
    "actions/checkout",
    "github/codeql-action/init",
    "github/codeql-action/analyze",
  ]);
  for (const { action, reference, comment } of actions) {
    assert.match(reference, fullSha, `${action} must use a full commit SHA`);
    assert.match(comment, /^v\d/u, `${action} must retain a readable version comment`);
  }
  assert.equal(actions[1].reference, actions[2].reference, "CodeQL init and analyze must use one reviewed release");
});

test("dependency review rejects new high-or-critical vulnerabilities on pull requests", () => {
  const workflow = source(".github/workflows/dependency-review.yml");
  const actions = actionReferences(workflow);

  assert.match(workflow, /^ {2}pull_request:\s*$/mu);
  assert.doesNotMatch(workflow, /^ {2}(?:push|schedule|workflow_dispatch):/mu);
  assert.match(workflow, /^permissions:\s*\n {2}contents:\s*read\s*$/mu);
  assert.match(workflow, /^ {10}fail-on-severity:\s*high\s*$/mu);
  assert.match(workflow, /persist-credentials:\s*false/iu);
  assert.deepEqual(actions.map(({ action }) => action), ["actions/checkout", "actions/dependency-review-action"]);
  for (const { action, reference, comment } of actions) {
    assert.match(reference, fullSha, `${action} must use a full commit SHA`);
    assert.match(comment, /^v\d/u, `${action} must retain a readable version comment`);
  }
});

test("governance contracts are an exact-once deterministic PR gate with one script owner", () => {
  const manifest = JSON.parse(source("package.json"));
  const catalog = JSON.parse(source("scripts/script-catalog.json"));
  const command = "npm run test:security-governance";

  assert.equal(manifest.scripts["test:security-governance"], "node --test scripts/ci/security-governance.test.mjs");
  assert.equal(manifest.scripts["check:pr"].split(command).length - 1, 1, `${command} must run exactly once`);

  const owners = catalog.categories.filter(({ paths }) => paths.includes("scripts/ci/security-governance.test.mjs"));
  assert.equal(owners.length, 1);
  assert.equal(owners[0].id, "security-workflow");
});
