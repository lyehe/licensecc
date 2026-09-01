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

function workflowTriggerLines(content) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const mapping = yamlMapping(line);
    return mapping && !mapping.listItem && mapping.indent === 0 && mapping.key === "on" && mapping.value === "";
  });
  assert.ok(start >= 0, "workflow is missing its on mapping");
  const nextRoot = lines.findIndex((line, index) => {
    if (index <= start || !line.trim()) return false;
    const mapping = yamlMapping(line);
    return mapping && !mapping.listItem && mapping.indent === 0;
  });
  return lines.slice(start + 1, nextRoot === -1 ? lines.length : nextRoot);
}

function workflowTriggerNames(content) {
  return workflowTriggerLines(content).flatMap((line) => {
    const mapping = yamlMapping(line);
    return mapping && !mapping.listItem && mapping.indent === 2 ? [mapping.key] : [];
  });
}

function workflowTriggerPaths(content, triggerName) {
  const lines = workflowTriggerLines(content);
  const triggerStart = lines.findIndex((line) => {
    const mapping = yamlMapping(line);
    return mapping && !mapping.listItem && mapping.indent === 2 && mapping.key === triggerName && mapping.value === "";
  });
  assert.ok(triggerStart >= 0, `workflow is missing its ${triggerName} mapping`);
  const triggerEndOffset = lines.slice(triggerStart + 1).findIndex((line) => {
    if (!line.trim()) return false;
    const mapping = yamlMapping(line);
    return mapping && !mapping.listItem && mapping.indent <= 2;
  });
  const triggerEnd = triggerEndOffset === -1 ? lines.length : triggerStart + 1 + triggerEndOffset;
  const triggerLines = lines.slice(triggerStart + 1, triggerEnd);
  const pathsStart = triggerLines.findIndex((line) => {
    const mapping = yamlMapping(line);
    return mapping && !mapping.listItem && mapping.indent === 4 && mapping.key === "paths" && mapping.value === "";
  });
  assert.ok(pathsStart >= 0, `${triggerName} is missing its direct paths list`);
  const pathsEndOffset = triggerLines.slice(pathsStart + 1).findIndex((line) => line.trim() && indentation(line) <= 4);
  const pathsEnd = pathsEndOffset === -1 ? triggerLines.length : pathsStart + 1 + pathsEndOffset;
  return triggerLines.slice(pathsStart + 1, pathsEnd).flatMap((line) => {
    const active = yamlWithoutComment(line);
    if (!active.trim() || indentation(active) !== 6 || !active.trimStart().startsWith("- ")) return [];
    return [yamlScalar(active.trimStart().slice(2))];
  });
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
  assert.deepEqual(
    workflowTriggerNames(workflow).sort(),
    ["pull_request", "schedule", "workflow_dispatch"],
    `${relativePath}: workflow triggers must be pull_request, schedule, and workflow_dispatch only`,
  );
  assert.deepEqual(
    workflowTriggerPaths(workflow, "pull_request"),
    [
      ".github/workflows/postgres-conformance.yml",
      "package.json",
      "package-lock.json",
      "packages/cloudflare-runtime/**",
      "packages/licensing-domain/**",
      "scripts/generate-wrangler-types.mjs",
      "services/cloudflare-licensing-backend/**",
    ],
    `${relativePath}: pull_request paths must cover every input to live PostgreSQL conformance`,
  );
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
  for (const command of ["npm run test:repository", "npm run check:scripts", "npm run check:hotspots"]) {
    assert.equal(
      commands.filter((candidate) => candidate === command).length,
      1,
      `repository-quality must invoke ${command} exactly once`,
    );
  }
});

test("repository organization contracts are exact-once local PR gates", () => {
  const packageJson = JSON.parse(source("package.json"));
  assert.equal(packageJson.scripts.doctor, "node scripts/ci/repository-doctor.mjs");
  assert.equal(packageJson.scripts["check:scripts"], "node scripts/ci/check-script-catalog.mjs");
  assert.equal(packageJson.scripts["check:hotspots"], "node scripts/report-hotspots.mjs --check");
  assert.equal(
    packageJson.scripts["test:repository"],
    "node --test scripts/ci/check-script-catalog.test.mjs scripts/ci/ownership-contract.test.mjs scripts/ci/repository-doctor.test.mjs scripts/ci/run-offline-docs-quickstart.test.mjs",
  );
  for (const command of ["npm run test:repository", "npm run check:scripts", "npm run check:hotspots"]) {
    assert.equal(
      packageJson.scripts["check:pr"].split(" && ").filter((candidate) => candidate === command).length,
      1,
      `check:pr must invoke ${command} exactly once`,
    );
  }
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
  assert.equal(packageJson.scripts["test:release-operations"], "node --test scripts/check-release-tag.test.mjs scripts/check-worker-rollback-health.test.mjs scripts/materialize-deploy-configs.test.mjs scripts/rollback-workers.test.mjs");
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
  const job = workflowJobLines(".github/workflows/deploy-production.yml", "deploy");
  assertNoTopLevelWorkflowDefaults(workflow, ".github/workflows/deploy-production.yml");
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(workflow, /^\s*(?:push|pull_request|schedule):\s*$/mu);
  assert.match(workflow, /if: inputs\.confirmation == 'deploy-production' && github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /group: licensecc-production-operations/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/u);
  assert.match(workflow, /node scripts\/materialize-deploy-configs\.mjs --profile production/u);
  assert.match(workflow, /LICENSECC_EXPECTED_CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/u);
  assert.match(workflow, /LICENSECC_EXPECTED_D1_DATABASE_ID: \$\{\{ vars\.LICENSECC_D1_DATABASE_ID \}\}/u);
  assert.equal((workflow.match(/LICENSECC_EXPECTED_(?:BACKEND|ADMIN|PORTAL|BACKUP)_ORIGIN: \$\{\{ inputs\.(?:backend|admin|portal|backup)_url \}\}/gmu) ?? []).length, 4);
  assert.match(workflow, /npm --silent run validate:secret-inventory --workspace @licensecc\/cloudflare-licensing-backend -- --profile=production > "\$RUNNER_TEMP\/licensecc-deployment-evidence\/backend-secret-inventory\.json"/u);
  assert.match(workflow, /Verify protected backend secret inventory[\s\S]*CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}[\s\S]*CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/u);
  assert.ok(workflow.indexOf("validate:secret-inventory") < workflow.indexOf("run-protected-wrangler.mjs --operation dry-run --worker backend"));
  assert.doesNotMatch(workflow, /validate:staging-order/u);
  assert.equal((workflow.match(/run-protected-wrangler\.mjs --operation dry-run --worker/gmu) ?? []).length, 4);
  assert.equal((workflow.match(/run-protected-wrangler\.mjs --operation deploy --worker/gmu) ?? []).length, 4);
  assert.equal((workflow.match(/run-protected-wrangler\.mjs --operation migrate --worker backend/gmu) ?? []).length, 1);
  const backupDeploy = workflow.indexOf("run-protected-wrangler.mjs --operation deploy --worker backup");
  const backupGate = workflow.indexOf("backup:pre-migration");
  const migration = workflow.indexOf("run-protected-wrangler.mjs --operation migrate --worker backend");
  const backendDeploy = workflow.indexOf("run-protected-wrangler.mjs --operation deploy --worker backend");
  assert.ok(backupDeploy < backupGate && backupGate < migration && migration < backendDeploy,
    "backup deployment and completed backup must precede migration and application rollout");
  assert.doesNotMatch(workflow, /wrangler\.example\.(?:toml|jsonc)/u);
  assert.match(workflow, /validate:public-verifier/u);
  assert.match(workflow, /LICENSECC_PUBLIC_VERIFIER_FINGERPRINT: \$\{\{ secrets\.LICENSECC_PUBLIC_VERIFIER_FINGERPRINT \}\}/u);
  assert.match(workflow, /LICENSECC_PUBLIC_VERIFIER_DEVICE_PRIVATE_KEY_PKCS8_PEM: \$\{\{ secrets\.LICENSECC_PUBLIC_VERIFIER_DEVICE_PRIVATE_KEY_PKCS8_PEM \}\}/u);
  assert.match(workflow, /LICENSECC_PUBLIC_VERIFIER_DEVICE_KEY_ID: \$\{\{ secrets\.LICENSECC_PUBLIC_VERIFIER_DEVICE_KEY_ID \}\}/u);
  const productionVerifier = namedWorkflowStep(job, "Run proof-authenticated backend post-deploy drill", ".github/workflows/deploy-production.yml");
  assert.deepEqual(
    Object.fromEntries([...productionVerifier.children.get("env")].map(([key, property]) => [key, property.value])),
    {
      BACKEND_URL: "${{ inputs.backend_url }}",
      LICENSECC_PUBLIC_VERIFIER_PROJECT: "${{ vars.LICENSECC_PUBLIC_VERIFIER_PROJECT }}",
      LICENSECC_PUBLIC_VERIFIER_FEATURE: "${{ vars.LICENSECC_PUBLIC_VERIFIER_FEATURE }}",
      LICENSECC_PUBLIC_VERIFIER_FINGERPRINT: "${{ secrets.LICENSECC_PUBLIC_VERIFIER_FINGERPRINT }}",
      LICENSECC_PUBLIC_VERIFIER_DEVICE_PRIVATE_KEY_PKCS8_PEM: "${{ secrets.LICENSECC_PUBLIC_VERIFIER_DEVICE_PRIVATE_KEY_PKCS8_PEM }}",
      LICENSECC_PUBLIC_VERIFIER_DEVICE_KEY_ID: "${{ secrets.LICENSECC_PUBLIC_VERIFIER_DEVICE_KEY_ID }}",
    },
  );
  assert.match(productionVerifier.properties.get("run")?.value ?? "", /backend-public-verifier-drill\.json/u);
  const remainingProductionDrills = namedWorkflowStep(job, "Run remaining service post-deploy drills", ".github/workflows/deploy-production.yml");
  assert.equal(remainingProductionDrills.children.get("env")?.has("LICENSECC_PUBLIC_VERIFIER_DEVICE_PRIVATE_KEY_PKCS8_PEM"), false);
  assert.match(workflow, /validate:access-admin[^\n]*--read-only/u);
  assert.match(workflow, /validate:staging-portal/u);
  assert.match(workflow, /validate:deploy[^\n]*--require-d1-rest-token --require-trigger-token/u);
  assert.equal((workflow.match(/run-protected-wrangler\.mjs --operation deployments --worker/gmu) ?? []).length, 4);
  assert.equal((workflow.match(/^\s*capture_deployment (?:backend|admin|portal|backup)$/gmu) ?? []).length, 4);
  assert.equal((workflow.match(/capture-worker-deployment-transition\.mjs/gmu) ?? []).length, 1);
  assert.doesNotMatch(workflow, /npx --no-install wrangler (?:deploy|d1|deployments)/u);
  assert.doesNotMatch(workflow, /wrangler deployments list --json[^\n|]*>/u);
  assert.equal((workflow.match(/"status":"capture_failed"/gmu) ?? []).length, 1);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.doesNotMatch(workflow, /time-travel[^\n]*restore|--allow-nonempty-scratch/u);
});

test("staging deployment is isolated, confirmed, backup-gated, and exercises every service", () => {
  const workflow = source(".github/workflows/deploy-staging.yml");
  const job = workflowJobLines(".github/workflows/deploy-staging.yml", "deploy");
  assertNoTopLevelWorkflowDefaults(workflow, ".github/workflows/deploy-staging.yml");
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(workflow, /^\s*(?:push|pull_request|schedule):\s*$/mu);
  assert.match(workflow, /if: inputs\.confirmation == 'deploy-staging' && github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /environment: staging/u);
  assert.match(workflow, /group: licensecc-staging-operations/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/u);
  assert.match(workflow, /node scripts\/materialize-deploy-configs\.mjs --profile staging/u);
  assert.match(workflow, /LICENSECC_EXPECTED_CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/u);
  assert.match(workflow, /LICENSECC_EXPECTED_D1_DATABASE_ID: \$\{\{ vars\.LICENSECC_D1_DATABASE_ID \}\}/u);
  assert.equal((workflow.match(/LICENSECC_EXPECTED_(?:BACKEND|ADMIN|PORTAL|BACKUP)_ORIGIN: \$\{\{ inputs\.(?:backend|admin|portal|backup)_url \}\}/gmu) ?? []).length, 4);
  assert.match(workflow, /npm --silent run validate:secret-inventory --workspace @licensecc\/cloudflare-licensing-backend -- --profile=staging > "\$RUNNER_TEMP\/licensecc-deployment-evidence\/backend-secret-inventory\.json"/u);
  assert.ok(workflow.indexOf("validate:secret-inventory") < workflow.indexOf("run-protected-wrangler.mjs --operation dry-run --worker backend"));
  assert.match(workflow, /LICENSECC_STAGING_LEASE_DRILL_URL: \$\{\{ inputs\.backend_url \}\}/u);
  assert.match(workflow, /LICENSECC_STAGING_LEASE_ACCOUNT_TOKEN: \$\{\{ secrets\.LICENSECC_STAGING_LEASE_ACCOUNT_TOKEN \}\}/u);
  assert.match(workflow, /LICENSECC_STAGING_LEASE_DEVICE_PRIVATE_KEY_PKCS8_PEM: \$\{\{ secrets\.LICENSECC_STAGING_LEASE_DEVICE_PRIVATE_KEY_PKCS8_PEM \}\}/u);
  assert.match(workflow, /LICENSECC_STAGING_LEASE_PUBLIC_KEY_PKCS1_DER_BASE64: \$\{\{ secrets\.LICENSECC_STAGING_LEASE_PUBLIC_KEY_PKCS1_DER_BASE64 \}\}/u);
  assert.match(workflow, /LICENSECC_STAGING_LEASE_FIXTURE_JSON: \$\{\{ secrets\.LICENSECC_STAGING_LEASE_FIXTURE_JSON \}\}/u);
  assert.match(workflow, /LICENSECC_STAGING_LEASE_COMMIT: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /npm --silent run validate:staging-lease --workspace @licensecc\/cloudflare-licensing-backend > "\$RUNNER_TEMP\/licensecc-deployment-evidence\/backend-lease-drill\.json"/u);
  const stagingLease = namedWorkflowStep(job, "Verify scoped staging leases, proof, and signatures", ".github/workflows/deploy-staging.yml");
  assert.equal(stagingLease.children.get("env")?.get("LICENSECC_STAGING_LEASE_PUBLIC_KEY_PKCS1_DER_BASE64")?.value,
    "${{ secrets.LICENSECC_STAGING_LEASE_PUBLIC_KEY_PKCS1_DER_BASE64 }}");
  assert.equal((workflow.match(/LICENSECC_STAGING_LEASE_PUBLIC_KEY_PKCS1_DER_BASE64:/gmu) ?? []).length, 1);
  assert.match(workflow, /LICENSECC_STAGING_ORDER_DRILL_URL: \$\{\{ inputs\.backend_url \}\}/u);
  assert.doesNotMatch(workflow, /LICENSECC_STAGING_(?:LEASE|ORDER)_DRILL_URL: \$\{\{ vars\./u);
  assert.match(workflow, /LICENSECC_STAGING_ORDER_DRILL_KEY_ID: \$\{\{ secrets\.LICENSECC_STAGING_ORDER_DRILL_KEY_ID \}\}/u);
  assert.match(workflow, /LICENSECC_STAGING_ORDER_DRILL_SECRET_B64: \$\{\{ secrets\.LICENSECC_STAGING_ORDER_DRILL_SECRET_B64 \}\}/u);
  assert.match(workflow, /LICENSECC_STAGING_ORDER_DRILL_FIXTURE_JSON: \$\{\{ secrets\.LICENSECC_STAGING_ORDER_DRILL_FIXTURE_JSON \}\}/u);
  assert.match(workflow, /LICENSECC_STAGING_ORDER_DRILL_RUN_ID: \$\{\{ github\.run_id \}\}/u);
  assert.match(workflow, /LICENSECC_STAGING_ORDER_DRILL_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/u);
  assert.match(workflow, /LICENSECC_STAGING_ORDER_DRILL_COMMIT: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /npm --silent run validate:staging-order --workspace @licensecc\/cloudflare-licensing-backend > "\$RUNNER_TEMP\/licensecc-deployment-evidence\/backend-order-drill\.json"/u);
  assert.doesNotMatch(workflow, /inputs\.(?:order|order_key|order_secret|order_fixture)/iu);
  assert.equal((workflow.match(/run-protected-wrangler\.mjs --operation dry-run --worker/gmu) ?? []).length, 4);
  assert.equal((workflow.match(/run-protected-wrangler\.mjs --operation deploy --worker/gmu) ?? []).length, 4);
  assert.equal((workflow.match(/run-protected-wrangler\.mjs --operation migrate --worker backend/gmu) ?? []).length, 1);
  const backupDeploy = workflow.indexOf("run-protected-wrangler.mjs --operation deploy --worker backup");
  const backupGate = workflow.indexOf("backup:pre-migration");
  const migration = workflow.indexOf("run-protected-wrangler.mjs --operation migrate --worker backend");
  const backendDeploy = workflow.indexOf("run-protected-wrangler.mjs --operation deploy --worker backend");
  assert.ok(backupDeploy < backupGate && backupGate < migration && migration < backendDeploy);
  assert.match(workflow, /validate:public-verifier[^\n]*--expect-rate-limit --json/u);
  assert.doesNotMatch(workflow, /validate:public-verifier[^\n]*--rotate-fingerprint/u);
  assert.match(workflow, /LICENSECC_PUBLIC_VERIFIER_FINGERPRINT: \$\{\{ secrets\.LICENSECC_PUBLIC_VERIFIER_FINGERPRINT \}\}/u);
  assert.match(workflow, /LICENSECC_PUBLIC_VERIFIER_DEVICE_PRIVATE_KEY_PKCS8_PEM: \$\{\{ secrets\.LICENSECC_PUBLIC_VERIFIER_DEVICE_PRIVATE_KEY_PKCS8_PEM \}\}/u);
  assert.match(workflow, /LICENSECC_PUBLIC_VERIFIER_DEVICE_KEY_ID: \$\{\{ secrets\.LICENSECC_PUBLIC_VERIFIER_DEVICE_KEY_ID \}\}/u);
  const stagingVerifier = namedWorkflowStep(job, "Run proof-authenticated staging verifier drill", ".github/workflows/deploy-staging.yml");
  assert.match(stagingVerifier.properties.get("run")?.value ?? "", /backend-public-verifier-drill\.json/u);
  const remainingStagingDrills = namedWorkflowStep(job, "Run synthetic staging tenant drills", ".github/workflows/deploy-staging.yml");
  assert.equal(remainingStagingDrills.children.get("env")?.has("LICENSECC_PUBLIC_VERIFIER_DEVICE_PRIVATE_KEY_PKCS8_PEM"), false);
  assert.match(workflow, /validate:access-admin/u);
  assert.match(workflow, /LICENSECC_NON_ADMIN_ACCESS_JWT: \$\{\{ secrets\.LICENSECC_NON_ADMIN_ACCESS_JWT \}\}/u);
  assert.match(workflow, /validate:access-admin[^\n]*--require-non-admin/u);
  assert.match(workflow, /STAGING_PORTAL_ALLOW_SEAT_MUTATION: "1"/u);
  assert.match(workflow, /STAGING_PORTAL_ALLOW_DOWNLOAD: "1"/u);
  assert.match(workflow, /validate:staging-portal/u);
  assert.match(workflow, /validate:deploy[^\n]*--require-d1-rest-token --require-trigger-token/u);
  assert.equal((workflow.match(/run-protected-wrangler\.mjs --operation deployments --worker/gmu) ?? []).length, 4);
  assert.equal((workflow.match(/^\s*capture_deployment (?:backend|admin|portal|backup)$/gmu) ?? []).length, 4);
  assert.equal((workflow.match(/capture-worker-deployment-transition\.mjs/gmu) ?? []).length, 1);
  assert.doesNotMatch(workflow, /npx --no-install wrangler (?:deploy|d1|deployments)/u);
  assert.doesNotMatch(workflow, /wrangler deployments list --json[^\n|]*>/u);
  assert.equal((workflow.match(/"status":"capture_failed"/gmu) ?? []).length, 1);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.doesNotMatch(workflow, /wrangler\.example\.(?:toml|jsonc)|time-travel[^\n]*restore|--allow-nonempty-scratch/u);
});

test("staging capacity evidence is confirmed, operator-attested, secret-backed, retained, and fail-closed", () => {
  const relativePath = ".github/workflows/capacity.yml";
  const workflow = source(relativePath);
  const job = workflowJobLines(relativePath, "capacity");
  assertNoTopLevelWorkflowDefaults(workflow, relativePath);
  assert.deepEqual(workflowTriggerNames(workflow), ["workflow_dispatch"]);
  assert.deepEqual(workflowJobNames(workflow), ["capacity"]);
  assert.match(workflow, /^\s*confirmation:\s*$[\s\S]*?Type run-staging-capacity/mu);
  assert.match(workflow, /^\s*mode:\s*$[\s\S]*?type: choice\s*\n\s*options:\s*\n\s*- burst\s*\n\s*- soak\s*$/mu);
  assert.doesNotMatch(workflow, /^\s*- rehearsal\s*$/mu);
  assert.match(workflow, /^\s*peak_rps:\s*$[\s\S]*?required: true[\s\S]*?type: string/mu);
  assert.match(workflow, /^\s*max_concurrency:\s*$[\s\S]*?required: true[\s\S]*?type: string/mu);
  assert.match(workflow, /^\s*backend_deployment_id:\s*$[\s\S]*?required: true[\s\S]*?type: string/mu);
  assert.match(workflow, /^\s*backend_version_id:\s*$[\s\S]*?required: true[\s\S]*?type: string/mu);
  assert.match(workflow, /^\s*operator_attested_commit_sha:\s*$[\s\S]*?required: true[\s\S]*?type: string/mu);
  assert.doesNotMatch(workflow, /inputs\.(?:url|fingerprint|account_token|device_key|private_key|duration)/iu);
  assert.equal(job.properties.get("if")?.value, "inputs.confirmation == 'run-staging-capacity' && github.ref == 'refs/heads/main'");
  assert.equal(job.properties.get("environment")?.value, "staging");
  assert.equal(job.properties.get("timeout-minutes")?.value, "300");
  assert.match(workflow, /group: licensecc-staging-operations/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /^permissions:\s*\n\s*contents: read\s*$/mu);

  const externalUses = job.steps
    .map((step) => step.properties.get("uses"))
    .filter(Boolean);
  assert.equal(externalUses.length, 3);
  for (const uses of externalUses) {
    assert.match(uses.value, /^(?:actions\/checkout|actions\/setup-node|actions\/upload-artifact)@[0-9a-f]{40}$/u);
    assert.match(uses.comment, /^v4$/u);
  }
  const checkout = job.steps.find((step) => step.properties.get("uses")?.value.startsWith("actions/checkout@"));
  assert.ok(checkout);
  assert.equal(checkout.children.get("with")?.get("ref")?.value, "${{ github.sha }}");
  assert.equal(checkout.children.get("with")?.get("persist-credentials")?.value, "false");
  assertExactCriticalRun(
    namedWorkflowStep(job, "Bind checkout to workflow commit", relativePath),
    'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
    "capacity checkout binding",
  );
  assertExactCriticalRun(
    namedWorkflowStep(job, "Install locked workspace", relativePath),
    "npm ci",
    "capacity locked install",
  );
  const materialize = namedWorkflowStep(job, "Materialize and bind protected staging topology", relativePath);
  assert.equal(materialize.properties.get("run")?.value, "node scripts/materialize-deploy-configs.mjs --profile staging");
  assert.equal(materialize.children.get("env")?.get("LICENSECC_EXPECTED_BACKEND_CREDENTIAL_ORIGIN")?.value, "${{ vars.LICENSECC_CAPACITY_URL }}");
  assert.equal(materialize.children.get("env")?.get("LICENSECC_EXPECTED_CLOUDFLARE_ACCOUNT_ID")?.value, "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
  assert.equal(materialize.children.get("env")?.get("LICENSECC_EXPECTED_D1_DATABASE_ID")?.value, "${{ vars.LICENSECC_D1_DATABASE_ID }}");
  assertExactCriticalRun(
    namedWorkflowStep(job, "Validate capacity harness", relativePath),
    "npm run test:capacity --workspace @licensecc/cloudflare-licensing-backend",
    "capacity harness validation",
  );

  const validation = namedWorkflowStep(job, "Validate declared load and protected staging inputs", relativePath);
  const validationRun = validation.properties.get("run")?.value ?? "";
  assert.match(validationRun, /peak > 0 && peak <= 5000/u);
  assert.match(validationRun, /concurrency >= 1 && concurrency <= 512/u);
  assert.match(validationRun, /\^\[A-Za-z0-9_-\]\{1,128\}\$\/u\.test\(deploymentId\)/u);
  assert.match(validationRun, /versionId/u);
  assert.match(validationRun, /operatorAttestedCommit === process\.env\.GITHUB_SHA/u);
  assert.match(validationRun, /CAPACITY_MODE === "burst" \|\| process\.env\.CAPACITY_MODE === "soak"/u);
  assert.match(validationRun, /target\.protocol === "https:"/u);
  assert.match(validationRun, new RegExp(["BEGIN", "PRIVATE KEY"].join("[\\s\\S]+"), "u"));
  assert.match(validationRun, /privateKey\.includes\(privateKeyBegin\)/u);
  assert.match(validationRun, /privateKey\.includes\(privateKeyEnd\)/u);

  const capacity = namedWorkflowStep(job, "Run capacity harness and normalize evidence", relativePath);
  const environment = capacity.children.get("env");
  assert.ok(environment);
  const expectedEnvironment = {
    LICENSECC_CAPACITY_MODE: "${{ inputs.mode }}",
    LICENSECC_CAPACITY_PEAK_RPS: "${{ inputs.peak_rps }}",
    LICENSECC_CAPACITY_MAX_CONCURRENCY: "${{ inputs.max_concurrency }}",
    LICENSECC_CAPACITY_ENVIRONMENT: "staging",
    LICENSECC_RELEASE_COMMIT: "${{ github.sha }}",
    CAPACITY_OPERATOR_ATTESTED_COMMIT_SHA: "${{ inputs.operator_attested_commit_sha }}",
    LICENSECC_CAPACITY_URL: "${{ vars.LICENSECC_CAPACITY_URL }}",
    LICENSECC_CAPACITY_PROJECT: "${{ vars.LICENSECC_CAPACITY_PROJECT }}",
    LICENSECC_CAPACITY_FEATURE: "${{ vars.LICENSECC_CAPACITY_FEATURE }}",
    LICENSECC_CAPACITY_FINGERPRINT: "${{ secrets.LICENSECC_CAPACITY_FINGERPRINT }}",
    LICENSECC_CAPACITY_DEVICE_HASH: "${{ secrets.LICENSECC_CAPACITY_DEVICE_HASH }}",
    LICENSECC_CAPACITY_DEVICE_PRIVATE_KEY_PKCS8_PEM: "${{ secrets.LICENSECC_CAPACITY_DEVICE_PRIVATE_KEY_PKCS8_PEM }}",
    LICENSECC_CAPACITY_DEVICE_KEY_ID: "${{ secrets.LICENSECC_CAPACITY_DEVICE_KEY_ID }}",
  };
  assert.deepEqual(
    Object.fromEntries([...environment].map(([key, property]) => [key, property.value])),
    expectedEnvironment,
  );
  assert.doesNotMatch(workflow, /LICENSECC_CAPACITY_ACCOUNT_TOKEN|authorization_present/iu);
  const capacityRun = capacity.properties.get("run")?.value ?? "";
  assert.match(
    capacityRun,
    /npm --silent run capacity:public-verifier --workspace @licensecc\/cloudflare-licensing-backend > "\$RUNNER_TEMP\/licensecc-capacity-evidence\/evidence\.json"/u,
  );
  assert.match(capacityRun, /set \+e[\s\S]*capacity_status="\$\?"[\s\S]*set -e/u);
  assert.match(capacityRun, /schema_version === "licensecc\.public-verifier-capacity\.evidence\.v1"/u);
  assert.match(capacityRun, /evidence\.exact_commit_sha === process\.env\.GITHUB_SHA/u);
  assert.match(capacityRun, /evidence\.target === "<redacted>"/u);
  assert.match(capacityRun, /target_binding:/u);
  assert.match(capacityRun, /operator_attested_commit_sha: process\.env\.CAPACITY_OPERATOR_ATTESTED_COMMIT_SHA/u);
  assert.doesNotMatch(capacityRun, /deployed_commit_sha/u);
  assert.match(capacityRun, /acceptance_eligible: false/u);
  assert.match(capacityRun, /writeFileSync\(path, JSON\.stringify\(normalized/u);
  assert.match(capacityRun, /appendFileSync\(process\.env\.GITHUB_OUTPUT, "exit_code="/u);
  assert.doesNotMatch(capacityRun, /--(?:mode|url|peak-rps|max-concurrency|fingerprint|account-token|device-key)/u);

  const uploadIndex = job.steps.findIndex((step) => step.properties.get("name")?.value === "Retain redacted capacity evidence");
  const runIndex = job.steps.findIndex((step) => step.properties.get("name")?.value === "Run capacity harness and normalize evidence");
  const stabilityIndex = job.steps.findIndex((step) => step.properties.get("name")?.value === "Confirm the approved backend deployment stayed active");
  const enforceIndex = job.steps.findIndex((step) => step.properties.get("name")?.value === "Enforce capacity verdict");
  assert.ok(runIndex >= 0 && runIndex < stabilityIndex && stabilityIndex < uploadIndex && uploadIndex < enforceIndex);
  assert.equal(job.steps[stabilityIndex].properties.get("if")?.value, "${{ always() }}");
  assert.equal((workflow.match(/assert-worker-deployment\.mjs/gmu) ?? []).length, 2);
  assert.equal((workflow.match(/run-protected-wrangler\.mjs --operation deployments --worker backend/gmu) ?? []).length, 2);
  const upload = job.steps[uploadIndex];
  assert.equal(upload.properties.get("if")?.value, "${{ always() }}");
  assert.match(upload.properties.get("uses")?.value ?? "", /^actions\/upload-artifact@[0-9a-f]{40}$/u);
  assert.equal(upload.children.get("with")?.get("path")?.value, "${{ runner.temp }}/licensecc-capacity-evidence/evidence.json");
  assert.equal(upload.children.get("with")?.get("if-no-files-found")?.value, "error");
  const enforce = job.steps[enforceIndex];
  assert.equal(enforce.properties.get("if")?.value, "${{ always() }}");
  assert.equal(enforce.children.get("env")?.get("CAPACITY_EXIT_CODE")?.value, "${{ steps.capacity-run.outputs.exit_code }}");
  assert.equal(enforce.properties.get("run")?.value, 'test "$CAPACITY_EXIT_CODE" = "0"');

  const commands = executionRunCommands(job).join("\n");
  assert.doesNotMatch(commands, /wrangler\s+(?:deploy\b|rollback\b|d1\b|secret\b)|npm publish|gh release|git tag/iu);
  assert.doesNotMatch(workflow, /continue-on-error/iu);
});

test("recovery drill is protected, scratch-only, timed, and validates restored semantics", () => {
  const workflow = source(".github/workflows/recovery-drill.yml");
  assertNoTopLevelWorkflowDefaults(workflow, ".github/workflows/recovery-drill.yml");
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(workflow, /^\s*(?:push|pull_request|schedule):\s*$/mu);
  assert.match(workflow, /if: inputs\.confirmation == 'restore-staging-scratch' && github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /environment: staging/u);
  assert.match(workflow, /group: licensecc-staging-operations/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/u);
  assert.match(workflow, /timeout-minutes: 300/u);
  assert.match(workflow, /node scripts\/materialize-deploy-configs\.mjs --profile staging/u);
  assert.match(workflow, /LICENSECC_EXPECTED_CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/u);
  assert.match(workflow, /LICENSECC_EXPECTED_D1_DATABASE_ID: \$\{\{ vars\.LICENSECC_D1_DATABASE_ID \}\}/u);
  assert.match(workflow, /\^licensecc-restore-drill-/u);
  assert.match(workflow, /D1_DATABASE_ID: \$\{\{ vars\.LICENSECC_D1_DATABASE_ID \}\}/u);
  assert.match(workflow, /--expected-database-id "\$D1_DATABASE_ID"/u);
  assert.match(workflow, /--expected-database-name licensecc-online-verifier-staging/u);
  assert.match(workflow, /--max-backup-age-seconds 3600/u);
  assert.match(workflow, /--scratch-database "\$SCRATCH_DATABASE"/u);
  assert.match(workflow, /--source-database licensecc-online-verifier-staging/u);
  assert.match(workflow, /--require-restored-status active/u);
  assert.match(workflow, /--require-restored-status revoked/u);
  assert.match(workflow, /--confirm-scratch/u);
  assert.match(workflow, /elapsedSeconds < 14400/u);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.doesNotMatch(workflow, /--allow-nonempty-scratch|time-travel[^\n]*restore|licensecc-d1-backups(?:\s|["'])/u);
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
  const toolchains = { python_version: "3.12.8", uv_version: "0.12.5", dotnet_sdk_version: "8.0.423" };
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

test("change-aware and scheduled PostgreSQL 16 conformance runs the real fenced implementations", () => {
  const workflow = source(".github/workflows/postgres-conformance.yml");
  assertPostgresWorkflowContract(workflow);
});

test("PostgreSQL workflow commands cannot be replaced by inactive or bypassed YAML", () => {
  const workflow = source(".github/workflows/postgres-conformance.yml");
  const decoys = [
    workflow.replace("  pull_request:\n", "  # pull_request:\n"),
    workflow.replace('      - "services/cloudflare-licensing-backend/**"\n', ""),
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
      /critical step|direct env mapping|execution controls|top-level defaults|strictly deep-equal|workflow triggers|pull_request paths/u,
      `PostgreSQL workflow decoy ${index} must fail closed`,
    );
  }
});
