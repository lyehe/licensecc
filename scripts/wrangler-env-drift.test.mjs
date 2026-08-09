import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const WORKER_ENV_BOUNDARIES = [
  {
    name: "licensing backend",
    config: "services/cloudflare-licensing-backend/tsconfig.typecheck.json",
    generated: "services/cloudflare-licensing-backend/.wrangler/worker-configuration.d.ts",
    binding: "DB",
  },
  {
    name: "license admin",
    config: "services/cloudflare-license-admin/tsconfig.worker.typecheck.json",
    generated: "services/cloudflare-license-admin/.wrangler/worker-configuration.d.ts",
    binding: "DB",
  },
  {
    name: "customer portal",
    config: "services/cloudflare-customer-portal/tsconfig.worker.typecheck.json",
    generated: "services/cloudflare-customer-portal/.wrangler/worker-configuration.d.ts",
    binding: "DB",
  },
  {
    name: "D1 backup",
    config: "services/cloudflare-d1-backup/tsconfig.typecheck.json",
    generated: "services/cloudflare-d1-backup/.wrangler/worker-configuration.d.ts",
    binding: "BACKUP_BUCKET",
  },
];

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function parseConfig(relativePath) {
  const configPath = resolve(REPOSITORY_ROOT, relativePath);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(read.error, undefined, `${relativePath} must parse`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath);
  assert.equal(parsed.errors.length, 0, `${relativePath} must resolve without diagnostics`);
  return parsed;
}

function diagnosticsFor(parsed, generatedPath, generatedText) {
  const host = ts.createCompilerHost(parsed.options);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => samePath(fileName, generatedPath) ? generatedText : readFile(fileName);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host });
  return ts.getPreEmitDiagnostics(program);
}

function diagnosticText(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function withoutGeneratedBinding(generated, binding) {
  const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bindingLine = new RegExp(`^(\\s*)${escaped}:\\s*[^\\r\\n]*;\\r?\\n`, "m");
  assert.match(generated, bindingLine, `generated Cloudflare.Env must contain ${binding}`);
  return generated.replace(bindingLine, "");
}

for (const boundary of WORKER_ENV_BOUNDARIES) {
  test(`${boundary.name} rejects a generated ${boundary.binding} binding removal`, () => {
    const generatedPath = resolve(REPOSITORY_ROOT, boundary.generated);
    assert.ok(existsSync(generatedPath), `${boundary.generated} must be generated before this regression runs`);
    const generated = readFileSync(generatedPath, "utf8");
    const parsed = parseConfig(boundary.config);

    const baseline = diagnosticsFor(parsed, generatedPath, generated);
    assert.equal(
      baseline.length,
      0,
      `${boundary.name} baseline typecheck must be clean:\n${baseline.map(diagnosticText).join("\n")}`,
    );

    const driftDiagnostics = diagnosticsFor(parsed, generatedPath, withoutGeneratedBinding(generated, boundary.binding));
    assert.ok(
      driftDiagnostics.some((diagnostic) => diagnosticText(diagnostic).includes(`"${boundary.binding}"`) && diagnosticText(diagnostic).includes("keyof Env")),
      `${boundary.name} must reject generated ${boundary.binding} removal:\n${driftDiagnostics.map(diagnosticText).join("\n")}`,
    );
  });
}
