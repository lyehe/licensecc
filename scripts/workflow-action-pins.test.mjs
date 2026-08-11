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

function yamlWithoutComment(line) {
  let quote = null;
  let output = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      output += character;
      if (character === "\\" && quote === '"') {
        output += line[index + 1] ?? "";
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
      output += character;
    } else if (character === "#") {
      break;
    } else {
      output += character;
    }
  }
  return output;
}

function indentation(line) {
  return line.length - line.trimStart().length;
}

function workflowJobLinesFromSource(content, jobName) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => indentation(line) === 2 && yamlWithoutComment(line).trim() === `${jobName}:`);
  assert.ok(start >= 0, `missing ${jobName} job`);

  const end = lines.findIndex((line, index) => {
    if (index <= start) return false;
    return indentation(line) === 2 && yamlWithoutComment(line).trimEnd().endsWith(":");
  });
  return lines.slice(start, end === -1 ? lines.length : end);
}

function workflowJobLines(relativePath, jobName) {
  const lines = source(relativePath);
  const job = workflowJobLinesFromSource(lines, jobName);
  assert.ok(job.length > 0, `${relativePath}: missing ${jobName} job`);
  return job;
}

function workflowJobLinesFromText(contents, relativePath, jobName) {
  const job = workflowJobLinesFromSource(contents, jobName);
  assert.ok(job.length > 0, `${relativePath}: missing ${jobName} job`);
  return job;
}

function workflowNamedStep(contents, relativePath, jobName, stepName) {
  const lines = workflowJobLinesFromText(contents, relativePath, jobName);
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.ok(start >= 0, `${relativePath}: missing active step ${stepName}`);
  const level = indentation(lines[start]);
  const end = lines.findIndex((line, index) => index > start && indentation(line) === level && line.trimStart().startsWith("- "));
  return lines.slice(start, end === -1 ? lines.length : end);
}

function stepRun(step, stepName) {
  const start = step.findIndex((line) => /^\s*run:/u.test(line));
  assert.ok(start >= 0, `${stepName}: missing run command`);
  const match = /^(\s*)run:\s*(.*?)\s*$/u.exec(step[start]);
  assert.ok(match, `${stepName}: invalid run declaration`);
  const [, prefix, scalar] = match;
  if (!/^[>|][+-]?$/u.test(scalar)) return scalar;

  const body = [];
  for (const line of step.slice(start + 1)) {
    if (line.trim() === "") continue;
    if (indentation(line) <= prefix.length) break;
    body.push(line.trim());
  }
  return scalar.startsWith(">") ? body.join(" ") : body.join("\n");
}

function stepEnvironment(step, stepName) {
  const start = step.findIndex((line) => /^\s*env:\s*$/u.test(line));
  if (start < 0) return {};
  const level = indentation(step[start]);
  const environment = {};
  for (const line of step.slice(start + 1)) {
    if (line.trim() === "") continue;
    if (indentation(line) <= level) break;
    const match = /^\s*([A-Z][A-Z0-9_]*):\s*(.*?)\s*$/u.exec(line);
    assert.ok(match, `${stepName}: invalid environment entry`);
    environment[match[1]] = match[2];
  }
  return environment;
}

function mappingKey(line) {
  const match = /^\s*(?:-\s*)?(?:(["'])([^"']+)\1|([A-Za-z][A-Za-z0-9_-]*))\s*:/u.exec(line);
  return match?.[2] ?? match?.[3];
}

function assertUnconditionalCriticalStep(step, stepName) {
  const propertyLevel = indentation(step[0]) + 2;
  for (const line of step) {
    if (indentation(line) !== propertyLevel) continue;
    const key = mappingKey(line);
    assert.ok(!["if", "continue-on-error", "shell", "working-directory"].includes(key), `${stepName}: critical step must not use ${key ?? "execution controls"}`);
  }
}

function assertPostgresWorkflowContract(workflow, relativePath = ".github/workflows/postgres-conformance.yml") {
  for (const line of workflow.split(/\r?\n/u)) {
    if (indentation(line) !== 0) continue;
    const key = mappingKey(line);
    assert.notEqual(key, "defaults", "PostgreSQL workflow must not override the run shell through workflow defaults");
  }
  assert.match(workflow, /^\s*schedule:\s*$/m);
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
  assert.doesNotMatch(workflow, /^\s*(?:push|pull_request):\s*$/m);
  assert.match(
    workflow,
    /^\s*image:\s*postgres:16-alpine@sha256:[0-9a-f]{64}\s*$/m,
    "PostgreSQL service image must be immutable",
  );

  const job = workflowJobLinesFromText(workflow, relativePath, "postgres-conformance");
  for (const line of job) {
    if (indentation(line) !== 4) continue;
    const key = mappingKey(line);
    assert.ok(!["if", "continue-on-error", "defaults"].includes(key), `postgres-conformance job must not use ${key ?? "execution controls"}`);
  }

  const install = workflowNamedStep(workflow, relativePath, "postgres-conformance", "Install locked workspace");
  assertUnconditionalCriticalStep(install, "Install locked workspace");
  assert.equal(stepRun(install, "Install locked workspace"), "npm ci");

  const schema = workflowNamedStep(workflow, relativePath, "postgres-conformance", "Apply fresh disposable PostgreSQL schema");
  assertUnconditionalCriticalStep(schema, "Apply fresh disposable PostgreSQL schema");
  assert.equal(
    stepRun(schema, "Apply fresh disposable PostgreSQL schema"),
    'docker exec -i "${{ job.services.postgres.id }}" psql --username postgres --dbname licensecc --set ON_ERROR_STOP=on < services/cloudflare-licensing-backend/supabase-postgres/schema.pg.sql',
  );

  const conformance = workflowNamedStep(workflow, relativePath, "postgres-conformance", "Run actual Worker, adapter, nonce, CLI, and transaction conformance");
  assertUnconditionalCriticalStep(conformance, "PostgreSQL conformance");
  assert.deepEqual(stepEnvironment(conformance, "PostgreSQL conformance"), {
    DATABASE_URL: "postgresql://postgres:conformance-only@127.0.0.1:5432/licensecc",
  });
  assert.equal(
    stepRun(conformance, "PostgreSQL conformance"),
    "npm run test:pg:real --workspace @licensecc/cloudflare-licensing-backend",
  );
}

function executionRunCommands(lines) {
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const active = yamlWithoutComment(lines[index]);
    const match = /^(\s*)run:\s*(.*?)\s*$/u.exec(active);
    if (!match) continue;
    const baseIndent = match[1].length;
    const value = match[2];
    if (!/^(?:\||>)[+-]?$/u.test(value)) {
      if (value) commands.push(value.replace(/^(["'])(.*)\1$/u, "$2"));
      continue;
    }
    for (index += 1; index < lines.length; index += 1) {
      const candidate = lines[index];
      if (candidate.trim() && indentation(candidate) <= baseIndent) {
        index -= 1;
        break;
      }
      const command = yamlWithoutComment(candidate).trim();
      if (command) commands.push(command);
    }
  }
  return commands;
}

function activeWorkflowDirectives(lines) {
  const found = [];
  let runBlockIndent = null;
  for (const line of lines) {
    if (runBlockIndent !== null && line.trim() && indentation(line) <= runBlockIndent) runBlockIndent = null;
    if (runBlockIndent !== null) continue;
    const active = yamlWithoutComment(line);
    const match = /^(\s*)(?:-\s+)?([A-Za-z][A-Za-z0-9_-]*):(?:\s|$)/u.exec(active);
    if (!match) continue;
    const key = match[2];
    const remainder = active.slice(match[0].length).trim();
    if (key === "run" && /^(?:\||>)[+-]?$/u.test(remainder)) runBlockIndent = match[1].length;
    if (["if", "continue-on-error", "shell", "working-directory", "defaults"].includes(key)) found.push({ key, line: active.trim() });
  }
  return found;
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
  const commands = executionRunCommands(workflowJobLines(".github/workflows/lint.yml", "repository-quality"));
  assert.equal(
    commands.filter((command) => command === "npm run test:capabilities").length,
    1,
    "repository-quality must invoke test:capabilities exactly once",
  );
  assert.equal(
    commands.filter((command) => command === "npm run test:clean-checkout").length,
    1,
    "repository-quality must invoke test:clean-checkout exactly once",
  );
  assert.equal(
    commands.filter((command) => command === "npm run test:workflow-pins").length,
    1,
    "repository-quality must invoke test:workflow-pins exactly once",
  );
  assert.equal(
    commands.filter((command) => command === "npm run test:versions").length,
    1,
    "repository-quality must invoke test:versions exactly once",
  );
  assert.equal(
    commands.filter((command) => command === "npm run test:release-artifacts").length,
    1,
    "repository-quality must invoke test:release-artifacts exactly once",
  );
  assert.equal(
    commands.filter((command) => command === "npm run check:versions").length,
    1,
    "repository-quality must invoke check:versions exactly once",
  );
});

test("release artifact evidence is an exact-once local and repository-quality gate", () => {
  const packageJson = JSON.parse(source("package.json"));
  assert.equal(packageJson.scripts["test:release-artifacts"], "node --test scripts/release-artifacts.test.mjs");
  assert.equal(
    packageJson.scripts["check:pr"].split(" && ").filter((command) => command === "npm run test:release-artifacts").length,
    1,
    "check:pr must invoke test:release-artifacts exactly once",
  );
  const commands = executionRunCommands(workflowJobLines(".github/workflows/lint.yml", "repository-quality"));
  assert.equal(
    commands.filter((command) => command === "npm run test:release-artifacts").length,
    1,
    "repository-quality must invoke test:release-artifacts exactly once",
  );
});

test("the release-candidate workflow is manual and performs only local dry-run assembly", () => {
  const workflow = source(".github/workflows/release-artifacts.yml");
  const commands = executionRunCommands(workflowJobLines(".github/workflows/release-artifacts.yml", "assemble"));
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/mu);
  assert.ok(commands.includes("node scripts/assemble-release-artifacts.mjs"));
  assert.ok(commands.includes("--consumer-id \"$CONSUMER_ID\""));
  assert.ok(commands.some((command) => command.startsWith("--output ")));
  assert.ok(commands.some((command) => command.startsWith("--repeat-output ")));
  assert.doesNotMatch(commands.join("\n"), /(?:^|\s)(?:git\s+tag|gh\s+release|npm\s+publish|dotnet\s+nuget\s+push|wrangler\s+deploy)(?:\s|$)/imu);
  assert.doesNotMatch(workflow, /upload-artifact/iu);
});

test("pull requests run a clean, toolchain-backed double assembly rather than only fake artifact tests", () => {
  const workflow = source(".github/workflows/lint.yml");
  const jobLines = workflowJobLines(".github/workflows/lint.yml", "release-artifact-integration");
  assert.match(workflow, /^on:\s*\[pull_request\]/mu);
  assert.match(jobLines.join("\n"), /actions\/setup-python@/u);
  assert.match(jobLines.join("\n"), /astral-sh\/setup-uv@/u);
  assert.match(jobLines.join("\n"), /actions\/setup-dotnet@/u);
  const toolchains = JSON.parse(source("release-toolchains.json"));
  assert.match(jobLines.join("\n"), new RegExp(`python-version: "${toolchains.python_version}"`, "u"));
  assert.match(jobLines.join("\n"), new RegExp(`version: "${toolchains.uv_version}"`, "u"));
  assert.match(jobLines.join("\n"), new RegExp(`dotnet-version: "${toolchains.dotnet_sdk_version}"`, "u"));
  const commands = executionRunCommands(jobLines);
  assert.equal(commands.filter((command) => command === "node scripts/assemble-release-artifacts.mjs").length, 1);
  assert.equal(commands.filter((command) => command === "--repeat-output \"$RUNNER_TEMP/licensecc-release-artifacts-b\"").length, 1);
  assert.match(jobLines.join("\n"), /cmake ninja-build/u);
  assert.doesNotMatch(jobLines.join("\n"), /(?:^|\s)(?:git\s+tag|gh\s+release|npm\s+publish|dotnet\s+nuget\s+push|wrangler\s+deploy)(?:\s|$)/imu);
});

test("release workflows use exact toolchain pins and cannot bypass the real assembly", () => {
  const toolchains = JSON.parse(source("release-toolchains.json"));
  const jobs = [
    [".github/workflows/lint.yml", "release-artifact-integration"],
    [".github/workflows/release-artifacts.yml", "assemble"],
  ];
  for (const [path, job] of jobs) {
    const lines = workflowJobLines(path, job);
    const active = lines.map(yamlWithoutComment).join("\n");
    assert.match(active, new RegExp(`python-version: "${toolchains.python_version}"`, "u"), `${path} must pin Python exactly`);
    assert.match(active, new RegExp(`version: "${toolchains.uv_version}"`, "u"), `${path} must pin uv exactly`);
    assert.match(active, new RegExp(`dotnet-version: "${toolchains.dotnet_sdk_version}"`, "u"), `${path} must pin .NET exactly`);
    assert.deepEqual(activeWorkflowDirectives(lines), [], `${path}:${job} must not use if/continue-on-error/shell/working-directory/defaults`);
  }
});

test("workflow execution scanning ignores comments and quoted display decoys", () => {
  const job = workflowJobLinesFromSource([
    "jobs:",
    "  release:",
    "    steps:",
    "      - name: 'node scripts/assemble-release-artifacts.mjs'",
    "        run: |",
    "          # node scripts/assemble-release-artifacts.mjs",
    "          echo 'node scripts/assemble-release-artifacts.mjs'",
    "      - name: real command",
    "        run: node scripts/assemble-release-artifacts.mjs # actual command",
    "      # if: false",
    "      # continue-on-error: true",
    "",
  ].join("\n"), "release");
  const commands = executionRunCommands(job);
  assert.equal(commands.filter((command) => command === "node scripts/assemble-release-artifacts.mjs").length, 1);
  assert.deepEqual(activeWorkflowDirectives(job), []);
});

test("capability evidence remains a PR gate locally and in repository-quality", () => {
  const packageJson = JSON.parse(source("package.json"));
  assert.match(packageJson.scripts["check:pr"], /npm run test:capabilities/);
  assert.match(packageJson.scripts["check:pr"], /npm run check:capabilities/);
  assert.equal(packageJson.scripts["test:capabilities"], "node --test scripts/check-capability-registry.test.mjs");
  assert.equal(packageJson.scripts["check:capabilities"], "node scripts/check-capability-registry.mjs");

  const commands = executionRunCommands(workflowJobLines(".github/workflows/lint.yml", "repository-quality"));
  assert.equal(
    commands.filter((command) => command === "npm run check:capabilities").length,
    1,
    "repository-quality must invoke check:capabilities exactly once",
  );
});

test("scheduled PostgreSQL 16 conformance runs the real fenced implementations", () => {
  const workflow = source(".github/workflows/postgres-conformance.yml");
  assertPostgresWorkflowContract(workflow);
});

test("PostgreSQL workflow commands cannot be replaced by comments or string-like prose", () => {
  const workflow = source(".github/workflows/postgres-conformance.yml");
  const decoys = [
    workflow.replace("run: npm ci", "run: '# npm ci'"),
    workflow.replace(
      'docker exec -i "${{ job.services.postgres.id }}"',
      '# docker exec -i "${{ job.services.postgres.id }}"',
    ),
    workflow.replace(
      "run: npm run test:pg:real --workspace @licensecc/cloudflare-licensing-backend",
      "run: echo 'npm run test:pg:real --workspace @licensecc/cloudflare-licensing-backend'",
    ),
    workflow.replace(
      "DATABASE_URL: postgresql://postgres:conformance-only@127.0.0.1:5432/licensecc",
      "# DATABASE_URL: postgresql://postgres:conformance-only@127.0.0.1:5432/licensecc",
    ),
    workflow.replace(
      "- name: Run actual Worker, adapter, nonce, CLI, and transaction conformance",
      "- name: Run actual Worker, adapter, nonce, CLI, and transaction conformance\n        if: ${{ false }}",
    ),
    workflow.replace(
      "- name: Run actual Worker, adapter, nonce, CLI, and transaction conformance",
      "- name: Run actual Worker, adapter, nonce, CLI, and transaction conformance\n        continue-on-error: true",
    ),
    workflow.replace(
      "  postgres-conformance:\n    runs-on:",
      "  postgres-conformance:\n    if: ${{ false }}\n    runs-on:",
    ),
    workflow.replace(
      "  postgres-conformance:\n    runs-on:",
      "  postgres-conformance:\n    continue-on-error: true\n    runs-on:",
    ),
    workflow.replace(
      "- name: Run actual Worker, adapter, nonce, CLI, and transaction conformance",
      '- name: Run actual Worker, adapter, nonce, CLI, and transaction conformance\n        "if" : false',
    ),
    workflow.replace(
      "- name: Run actual Worker, adapter, nonce, CLI, and transaction conformance",
      "- name: Run actual Worker, adapter, nonce, CLI, and transaction conformance\n        'continue-on-error' : true",
    ),
    workflow.replace(
      "  postgres-conformance:\n    runs-on:",
      '  postgres-conformance:\n    "if" : false\n    runs-on:',
    ),
    workflow.replace(
      "  postgres-conformance:\n    runs-on:",
      "  postgres-conformance:\n    'continue-on-error' : true\n    runs-on:",
    ),
    workflow.replace(
      "jobs:",
      "'defaults' :\n  run:\n    shell: bash -c 'exit 0' {0}\n\njobs:",
    ),
  ];
  for (const [index, decoy] of decoys.entries()) {
    assert.throws(
      () => assertPostgresWorkflowContract(decoy, `comment-decoy-${index}.yml`),
      /Expected values to be strictly (?:equal|deep-equal)|invalid environment entry|(?:critical step|job) must not use|must not override the run shell/u,
    );
  }
});
