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
    source: "services/cloudflare-licensing-backend/src/env.ts",
    binding: "DB",
    incompatibleKind: "KVNamespace",
  },
  {
    name: "license admin",
    config: "services/cloudflare-license-admin/tsconfig.worker.typecheck.json",
    generated: "services/cloudflare-license-admin/.wrangler/worker-configuration.d.ts",
    source: "services/cloudflare-license-admin/src/worker/env.ts",
    binding: "DB",
    incompatibleKind: "KVNamespace",
  },
  {
    name: "customer portal",
    config: "services/cloudflare-customer-portal/tsconfig.worker.typecheck.json",
    generated: "services/cloudflare-customer-portal/.wrangler/worker-configuration.d.ts",
    source: "services/cloudflare-customer-portal/src/worker/env.ts",
    binding: "DB",
    incompatibleKind: "KVNamespace",
  },
  {
    name: "D1 backup",
    config: "services/cloudflare-d1-backup/tsconfig.typecheck.json",
    generated: "services/cloudflare-d1-backup/.wrangler/worker-configuration.d.ts",
    source: "services/cloudflare-d1-backup/src/index.ts",
    binding: "BACKUP_BUCKET",
    incompatibleKind: "KVNamespace",
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

function isBoundaryDiagnostic(diagnostic, boundary, expectedText) {
  return diagnostic.file !== undefined
    && samePath(diagnostic.file.fileName, resolve(REPOSITORY_ROOT, boundary.source))
    && diagnosticText(diagnostic).includes(`"${boundary.binding}"`)
    && diagnosticText(diagnostic).includes(expectedText);
}

function withoutGeneratedBinding(generated, binding) {
  const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bindingLine = new RegExp(`^(\\s*)${escaped}:\\s*[^\\r\\n]*;\\r?\\n`, "m");
  assert.match(generated, bindingLine, `generated Cloudflare.Env must contain ${binding}`);
  return generated.replace(bindingLine, "");
}

function withIncompatibleGeneratedBindingKind(generated, binding, incompatibleKind) {
  const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bindingLine = new RegExp(`^([\\t ]*)${escaped}:\\s*[^\\r\\n]*;`, "m");
  assert.match(generated, bindingLine, `generated Cloudflare.Env must contain ${binding}`);
  return generated.replace(bindingLine, `$1${binding}: ${incompatibleKind};`);
}

for (const boundary of WORKER_ENV_BOUNDARIES) {
  test(`${boundary.name} rejects generated ${boundary.binding} removal and kind substitution`, () => {
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
      driftDiagnostics.some((diagnostic) => isBoundaryDiagnostic(diagnostic, boundary, "keyof Env")),
      `${boundary.name} must reject generated ${boundary.binding} removal:\n${driftDiagnostics.map(diagnosticText).join("\n")}`,
    );

    const kindDiagnostics = diagnosticsFor(
      parsed,
      generatedPath,
      withIncompatibleGeneratedBindingKind(generated, boundary.binding, boundary.incompatibleKind),
    );
    assert.ok(
      kindDiagnostics.some((diagnostic) => isBoundaryDiagnostic(diagnostic, boundary, "constraint 'never'")),
      `${boundary.name} must reject generated ${boundary.binding} kind substitution:\n${kindDiagnostics.map(diagnosticText).join("\n")}`,
    );
  });
}
