import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { runWranglerTypes } from "./generate-wrangler-types.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

function createWorkspace() {
  return mkdtempSync(join(tmpdir(), "licensecc wrangler types "));
}

for (const configPath of ["configuration with spaces/wrangler.example.jsonc", "configuration with spaces/wrangler.example.toml"]) {
  test(`generates types through the root-pinned Wrangler for ${configPath}`, () => {
    const workspace = createWorkspace();
    const outputPath = "generated types/nested/worker-configuration.d.ts";
    const calls = [];

    try {
      const exitCode = runWranglerTypes({
        outputPath,
        configPath,
        cwd: workspace,
        spawnSync(command, argumentsList, options) {
          calls.push({ command, argumentsList, options });
          return { status: 0 };
        },
      });

      assert.equal(exitCode, 0);
      assert.ok(existsSync(join(workspace, dirname(outputPath))), "creates the output parent recursively");
      assert.deepEqual(calls, [{
        command: process.execPath,
        argumentsList: [
          join(repositoryRoot, "node_modules", "wrangler", "bin", "wrangler.js"),
          "types",
          outputPath,
          "--config",
          configPath,
        ],
        options: { cwd: workspace, stdio: "inherit" },
      }]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

test("preserves Wrangler's nonzero exit code and inherited diagnostics", () => {
  const workspace = createWorkspace();
  const calls = [];

  try {
    const exitCode = runWranglerTypes({
      outputPath: ".wrangler/worker-configuration.d.ts",
      configPath: "wrangler.example.jsonc",
      cwd: workspace,
      spawnSync(command, argumentsList, options) {
        calls.push({ command, argumentsList, options });
        return { status: 37 };
      },
    });

    assert.equal(exitCode, 37);
    assert.equal(calls[0].options.stdio, "inherit");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("surfaces process-launch errors", () => {
  const workspace = createWorkspace();
  const failure = new Error("pinned Wrangler was unavailable");

  try {
    assert.throws(
      () => runWranglerTypes({
        outputPath: ".wrangler/worker-configuration.d.ts",
        configPath: "wrangler.example.jsonc",
        cwd: workspace,
        spawnSync() {
          return { error: failure, status: null };
        },
      }),
      failure,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
