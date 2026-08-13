import assert from "node:assert/strict";
import test from "node:test";

import { evaluateRepositorySnapshot, formatDoctorReport } from "./repository-doctor.mjs";

function cleanSnapshot(overrides = {}) {
  return {
    trackedPaths: ["README.md", "services/example/wrangler.example.toml"],
    statusEntries: [],
    worktrees: ["C:/repo"],
    branches: ["main"],
    remotes: {
      origin: "https://github.com/lyehe/licensecc.git",
      upstream: "https://github.com/open-license-manager/licensecc.git",
    },
    mainDivergence: { ahead: 0, behind: 0 },
    localOutputs: [],
    tools: [
      { name: "Node.js", expected: ">=22", available: true, actual: "v22.0.0", matches: true },
    ],
    ...overrides,
  };
}

test("clean repository state passes without findings", () => {
  const result = evaluateRepositorySnapshot(cleanSnapshot());
  assert.deepEqual(result, { findings: [], summary: { errors: 0, warnings: 0 }, exitCode: 0 });
  assert.match(formatDoctorReport(result), /OK\s+No repository contract/u);
});

test("tracked repository contract violations fail closed", () => {
  const result = evaluateRepositorySnapshot(cleanSnapshot({
    trackedPaths: [
      ".gitmodules",
      "services/admin/.wrangler/state.json",
      "services/admin/wrangler.toml",
      "services/admin/.dev.vars",
      "services/admin/wrangler.example.toml",
    ],
  }));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    result.findings.map(({ code }) => code),
    [
      "DOCTOR_SUBMODULE_METADATA",
      "DOCTOR_TRACKED_GENERATED_STATE",
      "DOCTOR_TRACKED_LOCAL_SECRET",
      "DOCTOR_TRACKED_WRANGLER_CONFIG",
    ],
  );
});

test("local hygiene and toolchain drift are advisory by default", () => {
  const result = evaluateRepositorySnapshot(cleanSnapshot({
    statusEntries: [" M README.md"],
    worktrees: ["C:/repo", "C:/repo-task"],
    branches: Array.from({ length: 11 }, (_, index) => `task-${index}`),
    remotes: {
      origin: "https://github.com/open-license-manager/licensecc.git",
      upstream: "https://github.com/lyehe/licensecc.git",
    },
    mainDivergence: { ahead: 2, behind: 3 },
    localOutputs: ["build"],
    tools: [
      { name: "uv", expected: "0.5.15", available: true, actual: "uv 0.6.0", matches: false },
      { name: ".NET SDK", expected: "8.0.423", available: false, actual: "", matches: false },
    ],
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.errors, 0);
  assert.ok(result.summary.warnings >= 9);
  assert.ok(result.findings.some(({ code }) => code === "DOCTOR_MULTIPLE_WORKTREES"));
  assert.ok(result.findings.some(({ code }) => code === "DOCTOR_TOOL_MISSING"));
  assert.ok(result.findings.some(({ code }) => code === "DOCTOR_TOOL_VERSION"));
});

test("strict-local mode promotes advisory findings to a failing result", () => {
  const result = evaluateRepositorySnapshot(cleanSnapshot({ statusEntries: ["?? local.txt"] }), { strictLocal: true });
  assert.equal(result.summary.errors, 0);
  assert.equal(result.summary.warnings, 1);
  assert.equal(result.exitCode, 1);
});
