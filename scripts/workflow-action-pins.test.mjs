import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fullSha = /^[0-9a-f]{40}$/i;

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

function yamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2 || !((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) return trimmed;
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new Error(`invalid quoted YAML scalar: ${trimmed}`);
    }
  }
  return trimmed.slice(1, -1).replaceAll("''", "'");
}

function yamlMapping(line) {
  const active = yamlWithoutComment(line);
  const indent = indentation(active);
  let source = active.slice(indent);
  let listItem = false;
  if (source.startsWith("- ")) {
    listItem = true;
    source = source.slice(2);
  }
  let key;
  let remainder;
  if (source.startsWith('"') || source.startsWith("'")) {
    const quote = source[0];
    let end = 1;
    for (; end < source.length; end += 1) {
      if (quote === '"' && source[end] === "\\") {
        end += 1;
        continue;
      }
      if (source[end] !== quote) continue;
      if (quote === "'" && source[end + 1] === "'") {
        end += 1;
        continue;
      }
      break;
    }
    let separator = end + 1;
    while (/\s/u.test(source[separator] ?? "")) separator += 1;
    if (end >= source.length || source[separator] !== ":") return null;
    key = yamlScalar(source.slice(0, end + 1));
    remainder = source.slice(separator + 1).trim();
  } else {
    const match = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/u.exec(source);
    if (!match) return null;
    [, key, remainder = ""] = match;
  }
  const suffix = line.slice(active.length).trim();
  return { key, value: remainder, indent, listItem, line: active.trim(), comment: suffix.startsWith("#") ? suffix.slice(1).trim() : "" };
}

function blockScalar(lines, index, baseIndent, indicator) {
  const values = [];
  let next = index + 1;
  while (next < lines.length) {
    const candidate = lines[next];
    if (candidate.trim() && indentation(candidate) <= baseIndent) break;
    values.push(candidate);
    next += 1;
  }
  const minimum = values.filter((line) => line.trim()).reduce((current, line) => Math.min(current, indentation(line)), Infinity);
  const normalized = values.map((line) => (line.trim() ? line.slice(minimum) : ""));
  const folded = indicator.startsWith(">");
  const value = folded
    ? normalized.reduce((text, line) => {
      if (!line) return `${text}\n`;
      return text ? `${text}${text.endsWith("\n") ? "" : " "}${line}` : line;
    }, "").replace(/\n+$/u, "")
    : normalized.join("\n").replace(/\n+$/u, "");
  return { value, next, style: folded ? "folded" : "literal" };
}

function directProperty(lines, index, end, mapping) {
  const indicator = mapping.value;
  if (/^(?:\||>)[+-]?$/u.test(indicator)) {
    const scalar = blockScalar(lines, index, mapping.indent, indicator);
    return { property: { ...mapping, value: scalar.value, style: scalar.style }, next: scalar.next };
  }
  return { property: { ...mapping, value: yamlScalar(mapping.value), style: "plain" }, next: index + 1 };
}

function nestedProperties(lines, index, end, parentIndent) {
  const properties = new Map();
  let next = index;
  while (next < end) {
    const raw = lines[next];
    if (!raw.trim()) {
      next += 1;
      continue;
    }
    if (indentation(raw) <= parentIndent) break;
    const mapping = yamlMapping(raw);
    if (!mapping || mapping.listItem || mapping.indent !== parentIndent + 2) {
      next += 1;
      continue;
    }
    const parsed = directProperty(lines, next, end, mapping);
    if (properties.has(parsed.property.key)) throw new Error(`duplicate YAML mapping key ${parsed.property.key}`);
    properties.set(parsed.property.key, parsed.property);
    next = parsed.next;
  }
  return { properties, next };
}

function workflowJobLinesFromSource(content, jobName) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const mapping = yamlMapping(line);
    return mapping && !mapping.listItem && mapping.indent === 2 && mapping.key === jobName && mapping.value === "";
  });
  assert.ok(start >= 0, `missing ${jobName} job`);

  const end = lines.findIndex((line, index) => {
    if (index <= start) return false;
    const mapping = yamlMapping(line);
    return mapping && !mapping.listItem && mapping.indent === 2;
  });
  const jobEnd = end === -1 ? lines.length : end;
  const properties = new Map();
  const steps = [];
  let index = start + 1;
  while (index < jobEnd) {
    const raw = lines[index];
    if (!raw.trim()) {
      index += 1;
      continue;
    }
    const mapping = yamlMapping(raw);
    if (!mapping || mapping.listItem || mapping.indent !== 4) {
      index += 1;
      continue;
    }
    if (mapping.key === "steps" && mapping.value === "") {
      index += 1;
      while (index < jobEnd) {
        const stepLine = lines[index];
        if (!stepLine.trim()) {
          index += 1;
          continue;
        }
        const first = yamlMapping(stepLine);
        if (!first || !first.listItem || first.indent !== 6) break;
        const step = { properties: new Map(), children: new Map() };
        const firstProperty = directProperty(lines, index, jobEnd, { ...first, listItem: false });
        step.properties.set(firstProperty.property.key, firstProperty.property);
        index = firstProperty.next;
        while (index < jobEnd) {
          const propertyLine = lines[index];
          if (!propertyLine.trim()) {
            index += 1;
            continue;
          }
          const property = yamlMapping(propertyLine);
          if (property?.listItem && property.indent === 6) break;
          if (!property || property.listItem || property.indent !== 8) {
            if (indentation(propertyLine) <= 6) break;
            index += 1;
            continue;
          }
          if (step.properties.has(property.key)) throw new Error(`duplicate YAML step key ${property.key}`);
          if (property.value === "") {
            const nested = nestedProperties(lines, index + 1, jobEnd, property.indent);
            step.properties.set(property.key, { ...property, value: "", style: "mapping" });
            step.children.set(property.key, nested.properties);
            index = nested.next;
          } else {
            const parsed = directProperty(lines, index, jobEnd, property);
            step.properties.set(parsed.property.key, parsed.property);
            index = parsed.next;
          }
        }
        steps.push(step);
      }
      continue;
    }
    const parsed = directProperty(lines, index, jobEnd, mapping);
    if (properties.has(parsed.property.key)) throw new Error(`duplicate YAML job key ${parsed.property.key}`);
    properties.set(parsed.property.key, parsed.property);
    index = parsed.next;
  }
  return { rawLines: lines.slice(start, jobEnd), properties, steps };
}

function workflowJobLines(relativePath, jobName) {
  const lines = source(relativePath);
  const job = workflowJobLinesFromSource(lines, jobName);
  assert.ok(job.rawLines.length > 0, `${relativePath}: missing ${jobName} job`);
  return job;
}

function workflowJobNames(content) {
  const lines = content.split(/\r?\n/);
  const jobsStart = lines.findIndex((line) => {
    const mapping = yamlMapping(line);
    return mapping && !mapping.listItem && mapping.indent === 0 && mapping.key === "jobs" && mapping.value === "";
  });
  assert.ok(jobsStart >= 0, "workflow is missing its jobs mapping");
  const names = [];
  for (let index = jobsStart + 1; index < lines.length; index += 1) {
    const mapping = yamlMapping(lines[index]);
    if (mapping && !mapping.listItem && mapping.indent === 0) break;
    if (mapping && !mapping.listItem && mapping.indent === 2 && mapping.value === "") names.push(mapping.key);
  }
  return names;
}

function executionRunCommands(job) {
  return job.steps.flatMap((step) => {
    const run = step.properties.get("run");
    if (!run?.value) return [];
    if (run.style === "literal") return run.value.split("\n").map((line) => yamlWithoutComment(line).trim()).filter(Boolean);
    return [yamlWithoutComment(run.value).trim()].filter(Boolean);
  });
}

const workflowGuardKeys = new Set(["if", "continue-on-error", "shell", "working-directory", "defaults"]);

function activeWorkflowDirectives(job) {
  return [job.properties, ...job.steps.map((step) => step.properties)].flatMap((properties) => [...properties.values()].filter((property) => workflowGuardKeys.has(property.key)).map((property) => ({ key: property.key, line: property.line })));
}

function assertNoTopLevelWorkflowDefaults(content, label) {
  for (const line of content.split(/\r?\n/)) {
    const mapping = yamlMapping(line);
    if (mapping && !mapping.listItem && mapping.indent === 0 && mapping.key === "defaults") throw new Error(`${label}: must not use top-level defaults`);
  }
}

function assertExactReleaseAssemblyInvocation(job, expected, label) {
  const candidates = job.steps
    .map((step) => step.properties.get("run"))
    .filter((run) => run?.value.includes("scripts/assemble-release-artifacts.mjs"));
  assert.equal(candidates.length, 1, `${label}: requires exactly one direct release assembly invocation`);
  const [run] = candidates;
  assert.notEqual(run.style, "literal", `${label}: release assembly must be one reconstructed scalar`);
  assert.equal(run.value, expected, `${label}: requires an exact release assembly invocation`);
}

function assertNoCommandsAfterUnconditionalExit(job, label) {
  for (const [stepIndex, step] of job.steps.entries()) {
    const run = step.properties.get("run");
    if (!run) continue;
    const commands = run.style === "literal" ? run.value.split("\n") : [run.value];
    let exited = false;
    for (const command of commands) {
      const active = yamlWithoutComment(command).trim();
      if (!active) continue;
      if (exited) throw new Error(`${label}: step ${stepIndex + 1} has a command after unconditional exit`);
      if (/^exit(?:\s+(?:0|[1-9]\d*))?\s*;?$/u.test(active)) exited = true;
    }
  }
}

function assertExactSetupPins(job, toolchains, label) {
  const required = [
    ["actions/setup-python", "python-version", toolchains.python_version],
    ["astral-sh/setup-uv", "version", toolchains.uv_version],
    ["actions/setup-dotnet", "dotnet-version", toolchains.dotnet_sdk_version],
    ["actions/setup-java", "java-version", toolchains.java_setup_version],
  ];
  for (const [action, withKey, expected] of required) {
    const matched = job.steps.filter((step) => step.properties.get("uses")?.value.startsWith(`${action}@`));
    assert.equal(matched.length, 1, `${label}: requires exactly one direct ${action} step`);
    const uses = matched[0].properties.get("uses").value;
    assert.match(uses, new RegExp(`^${action.replace("/", "\\/")}@[0-9a-f]{40}$`, "u"), `${label}: ${action} must be SHA pinned in uses`);
    const configured = matched[0].children.get("with")?.get(withKey);
    assert.ok(configured, `${label}: ${action} must configure ${withKey} in its direct with mapping`);
    assert.equal(configured.value, expected, `${label}: ${action} must configure ${withKey} from the tracked authority`);
    if (action === "actions/setup-java") {
      assert.equal(matched[0].children.get("with")?.get("distribution")?.value, "temurin", `${label}: setup-java must use the tracked Temurin distribution contract`);
    }
  }
}

function namedWorkflowStep(job, stepName, label) {
  const matches = job.steps.filter((step) => step.properties.get("name")?.value === stepName);
  assert.equal(matches.length, 1, `${label}: requires exactly one ${stepName} step`);
  return matches[0];
}

function assertExactCriticalRun(step, expected, label) {
  const controls = [...step.properties.keys()].filter((key) => workflowGuardKeys.has(key));
  assert.deepEqual(controls, [], `${label}: critical step must not use execution controls`);
  const run = step.properties.get("run");
  assert.ok(run, `${label}: critical step is missing its run command`);
  assert.equal(run.value, expected, `${label}: critical step command drifted`);
}

function assertPostgresWorkflowContract(workflow, relativePath = ".github/workflows/postgres-conformance.yml") {
  assertNoTopLevelWorkflowDefaults(workflow, relativePath);
  assert.match(workflow, /^\s*schedule:\s*$/mu);
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(workflow, /^\s*(?:push|pull_request):\s*$/mu);
  assert.match(
    workflow,
    /^\s*image:\s*postgres:16-alpine@sha256:[0-9a-f]{64}\s*$/mu,
    "PostgreSQL service image must be immutable",
  );

  const job = workflowJobLinesFromSource(workflow, "postgres-conformance");
  assert.deepEqual(activeWorkflowDirectives(job), [], `${relativePath}: postgres-conformance must not use execution controls`);

  const install = namedWorkflowStep(job, "Install locked workspace", relativePath);
  assertExactCriticalRun(install, "npm ci", "Install locked workspace");

  const schema = namedWorkflowStep(job, "Apply fresh disposable PostgreSQL schema", relativePath);
  assertExactCriticalRun(
    schema,
    'docker exec -i "${{ job.services.postgres.id }}" psql --username postgres --dbname licensecc --set ON_ERROR_STOP=on < services/cloudflare-licensing-backend/supabase-postgres/schema.pg.sql',
    "Apply fresh disposable PostgreSQL schema",
  );

  const conformance = namedWorkflowStep(job, "Run actual Worker, adapter, nonce, CLI, and transaction conformance", relativePath);
  assertExactCriticalRun(
    conformance,
    "npm run test:pg:real --workspace @licensecc/cloudflare-licensing-backend",
    "PostgreSQL conformance",
  );
  const environment = conformance.children.get("env");
  assert.ok(environment, "PostgreSQL conformance requires a direct env mapping");
  assert.deepEqual(
    Object.fromEntries([...environment].map(([key, property]) => [key, property.value])),
    { DATABASE_URL: "postgresql://postgres:conformance-only@127.0.0.1:5432/licensecc" },
  );
}

function workflowReferences() {
  return trackedWorkflowPaths().flatMap((path) => {
    const content = source(path);
    return workflowJobNames(content).flatMap((jobName) => workflowJobLinesFromSource(content, jobName).steps.flatMap((step) => {
      const uses = step.properties.get("uses");
      return uses ? [{ path, reference: uses.value, comment: uses.comment }] : [];
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

test("release and deployment operation contracts are deterministic PR gates", () => {
  const packageJson = JSON.parse(source("package.json"));
  assert.equal(packageJson.scripts["test:release-operations"], "node --test scripts/check-release-tag.test.mjs scripts/materialize-deploy-configs.test.mjs");
  assert.equal(packageJson.scripts["check:pr"].split(" && ").filter((command) => command === "npm run test:release-operations").length, 1);
});

test("platform tags build once and publish through protected trusted-publisher jobs", () => {
  const workflow = source(".github/workflows/platform-release.yml");
  const toolchains = JSON.parse(source("release-toolchains.json"));
  const nugetJob = workflowJobLines(".github/workflows/platform-release.yml", "publish-nuget").rawLines.join("\n");
  assert.match(workflow, /^\s*tags:\s*\n\s*- "platform-v\*"\s*$/mu);
  assert.doesNotMatch(workflow, /^\s*workflow_dispatch:\s*$/mu);
  assert.match(workflow, /environment: pypi/u);
  assert.match(workflow, /environment: nuget/u);
  assert.match(workflow, /environment: github-release/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /node scripts\/check-release-tag\.mjs "\$GITHUB_REF_NAME"/u);
  assert.match(workflow, /pypa\/gh-action-pypi-publish@[0-9a-f]{40}/u);
  assert.match(workflow, /NuGet\/login@[0-9a-f]{40}/u);
  assert.match(
    nugetJob,
    new RegExp(`actions/setup-dotnet@[0-9a-f]{40}[\\s\\S]*dotnet-version: ["']?${escapeRegExp(toolchains.dotnet_sdk_version)}["']?`, "u"),
  );
  assert.match(workflow, /dotnet nuget push release\/dotnet\/\*\.nupkg/u);
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"/u);
  assert.equal((workflow.match(/node scripts\/assemble-release-artifacts\.mjs/gmu) ?? []).length, 1);
});

test("production deployment is manual, confirmed, serialized, and uses only materialized configs", () => {
  const workflow = source(".github/workflows/deploy-production.yml");
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(workflow, /^\s*(?:push|pull_request|schedule):\s*$/mu);
  assert.match(workflow, /if: inputs\.confirmation == 'deploy-production'/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /node scripts\/materialize-deploy-configs\.mjs/u);
  assert.equal((workflow.match(/wrangler deploy --dry-run --config services\//gmu) ?? []).length, 4);
  assert.equal((workflow.match(/wrangler deploy --config services\//gmu) ?? []).length, 4);
  assert.equal((workflow.match(/wrangler d1 migrations apply DB --remote/gmu) ?? []).length, 1);
  assert.ok(workflow.indexOf("wrangler d1 migrations apply DB --remote") < workflow.indexOf("wrangler deploy --config services/cloudflare-licensing-backend"));
  assert.doesNotMatch(workflow, /wrangler\.example\.(?:toml|jsonc)/u);
  assert.match(workflow, /validate:public-verifier/u);
  assert.match(workflow, /validate:deploy/u);
});

test("the release-candidate workflow is manual and performs only local dry-run assembly", () => {
  const workflow = source(".github/workflows/release-artifacts.yml");
  const job = workflowJobLines(".github/workflows/release-artifacts.yml", "assemble");
  const commands = executionRunCommands(job);
  assertNoTopLevelWorkflowDefaults(workflow, ".github/workflows/release-artifacts.yml");
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/mu);
  assertExactReleaseAssemblyInvocation(job, "node scripts/assemble-release-artifacts.mjs --output \"$RUNNER_TEMP/licensecc-release-artifacts\" --repeat-output \"$RUNNER_TEMP/licensecc-release-artifacts-repeat\" --consumer-id \"$CONSUMER_ID\"", ".github/workflows/release-artifacts.yml:assemble");
  assert.doesNotMatch(commands.join("\n"), /(?:^|\s)(?:git\s+tag|gh\s+release|npm\s+publish|dotnet\s+nuget\s+push|wrangler\s+deploy)(?:\s|$)/imu);
  assert.doesNotMatch(workflow, /upload-artifact/iu);
});

test("pull requests run a clean, toolchain-backed double assembly rather than only fake artifact tests", () => {
  const workflow = source(".github/workflows/lint.yml");
  const job = workflowJobLines(".github/workflows/lint.yml", "release-artifact-integration");
  const jobSource = job.rawLines.join("\n");
  assert.match(workflow, /^on:\s*\[pull_request\]/mu);
  assert.match(jobSource, /actions\/setup-python@/u);
  assert.match(jobSource, /astral-sh\/setup-uv@/u);
  assert.match(jobSource, /actions\/setup-dotnet@/u);
  assert.match(jobSource, /actions\/setup-java@/u);
  const toolchains = JSON.parse(source("release-toolchains.json"));
  assertExactSetupPins(job, toolchains, ".github/workflows/lint.yml:release-artifact-integration");
  const commands = executionRunCommands(job);
  assertNoTopLevelWorkflowDefaults(workflow, ".github/workflows/lint.yml");
  assertExactReleaseAssemblyInvocation(job, "node scripts/assemble-release-artifacts.mjs --output \"$RUNNER_TEMP/licensecc-release-artifacts-a\" --repeat-output \"$RUNNER_TEMP/licensecc-release-artifacts-b\" --consumer-id release-candidate", ".github/workflows/lint.yml:release-artifact-integration");
  assert.match(jobSource, /cmake ninja-build/u);
  assert.doesNotMatch(commands.join("\n"), /(?:^|\s)(?:git\s+tag|gh\s+release|npm\s+publish|dotnet\s+nuget\s+push|wrangler\s+deploy)(?:\s|$)/imu);
  assertNoCommandsAfterUnconditionalExit(job, ".github/workflows/lint.yml:release-artifact-integration");
});

test("release workflows use exact toolchain pins and cannot bypass the real assembly", () => {
  const toolchains = JSON.parse(source("release-toolchains.json"));
  const jobs = [
    [".github/workflows/lint.yml", "release-artifact-integration"],
    [".github/workflows/release-artifacts.yml", "assemble"],
    [".github/workflows/platform-release.yml", "build"],
  ];
  for (const [path, job] of jobs) {
    const parsed = workflowJobLines(path, job);
    assertNoTopLevelWorkflowDefaults(source(path), path);
    assertExactSetupPins(parsed, toolchains, `${path}:${job}`);
    assert.deepEqual(activeWorkflowDirectives(parsed), [], `${path}:${job} must not use if/continue-on-error/shell/working-directory/defaults`);
    assertNoCommandsAfterUnconditionalExit(parsed, `${path}:${job}`);
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

test("workflow execution scanning accepts only actual step run mappings and quoted guard keys", () => {
  const job = workflowJobLinesFromSource([
    "jobs:",
    "  release:",
    "    steps:",
    "      - name: actions/setup-python@not-an-action",
    "        env:",
    "          run: node scripts/assemble-release-artifacts.mjs",
    "          python-version: 3.12.8",
    "        \"if\": \"false\"",
    "        'continue-on-error': 'true'",
    "        run: node scripts/assemble-release-artifacts.mjs",
    "",
  ].join("\n"), "release");
  assert.deepEqual(
    executionRunCommands(job),
    ["node scripts/assemble-release-artifacts.mjs"],
    "env.run and names are inert; only the step run mapping executes",
  );
  assert.deepEqual(activeWorkflowDirectives(job).map(({ key }) => key).sort(), ["continue-on-error", "if"]);
});

test("workflow structural checks reject inert pin decoys, quoted guards, and commands after exit", () => {
  const toolchains = { python_version: "3.12.8", uv_version: "0.5.15", dotnet_sdk_version: "8.0.423" };
  const decoy = workflowJobLinesFromSource([
    "jobs:",
    "  release:",
    "    steps:",
    "      - name: actions/setup-python@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "        env:",
    "          uses: actions/setup-python@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "          python-version: 3.12.8",
    "        run: |",
    "          exit 0",
    "          node scripts/assemble-release-artifacts.mjs",
    "",
  ].join("\n"), "release");
  assert.throws(() => assertExactSetupPins(decoy, toolchains, "fixture"), /direct actions\/setup-python step/i);
  assert.throws(() => assertNoCommandsAfterUnconditionalExit(decoy, "fixture"), /after unconditional exit/i);

  const quotedGuard = workflowJobLinesFromSource([
    "jobs:",
    "  release:",
    "    'if': false",
    "    steps:",
    "      - run: node scripts/assemble-release-artifacts.mjs",
    "        \"shell\": bash",
    "",
  ].join("\n"), "release");
  assert.deepEqual(activeWorkflowDirectives(quotedGuard).map(({ key }) => key).sort(), ["if", "shell"]);
});

test("release assembly is one exact scalar and workflow-level defaults are rejected", () => {
  const expected = "node scripts/assemble-release-artifacts.mjs --output \"$RUNNER_TEMP/licensecc-release-artifacts-a\" --repeat-output \"$RUNNER_TEMP/licensecc-release-artifacts-b\" --consumer-id release-candidate";
  const bypasses = [
    "true && exit 0 && node scripts/assemble-release-artifacts.mjs --output \"$RUNNER_TEMP/licensecc-release-artifacts-a\" --repeat-output \"$RUNNER_TEMP/licensecc-release-artifacts-b\" --consumer-id release-candidate",
    "exec true; node scripts/assemble-release-artifacts.mjs --output \"$RUNNER_TEMP/licensecc-release-artifacts-a\" --repeat-output \"$RUNNER_TEMP/licensecc-release-artifacts-b\" --consumer-id release-candidate",
    "node scripts/assemble-release-artifacts.mjs --output \"$RUNNER_TEMP/licensecc-release-artifacts-a\" --repeat-output \"$RUNNER_TEMP/licensecc-release-artifacts-b\" --consumer-id release-candidate && true",
  ];
  for (const command of bypasses) {
    const job = workflowJobLinesFromSource([
      "jobs:",
      "  release:",
      "    steps:",
      "      - run: >-",
      `          ${command}`,
      "",
    ].join("\n"), "release");
    assert.throws(() => assertExactReleaseAssemblyInvocation(job, expected, "fixture"), /exact release assembly invocation/i);
  }
  const workflowDefaults = [
    "\"defaults\":",
    "  run:",
    "    shell: bash",
    "jobs:",
    "  release:",
    "    steps:",
    "      - run: node scripts/assemble-release-artifacts.mjs",
    "",
  ].join("\n");
  assert.throws(() => assertNoTopLevelWorkflowDefaults(workflowDefaults, "fixture"), /top-level defaults/i);
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

test("PostgreSQL workflow commands cannot be replaced by inactive or bypassed YAML", () => {
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
      () => assertPostgresWorkflowContract(decoy, `postgres-decoy-${index}.yml`),
      /critical step|direct env mapping|execution controls|top-level defaults|strictly deep-equal/u,
      `PostgreSQL workflow decoy ${index} must fail closed`,
    );
  }
});
