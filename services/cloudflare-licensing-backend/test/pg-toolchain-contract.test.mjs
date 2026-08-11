import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const read = (path) => readFileSync(resolve(repositoryRoot, path), "utf8");

test("PostgreSQL parity uses one checked uv and Python dependency contract", () => {
  assert.equal(read("uv.toml"), 'required-version = "==0.5.15"\n');

  const backend = JSON.parse(read("services/cloudflare-licensing-backend/package.json"));
  assert.equal(
    backend.scripts["schema:parity:pg"],
    "uv run --directory scripts/pg-parity --locked python ../check-pg-parity.py",
  );

  const project = read("services/cloudflare-licensing-backend/scripts/pg-parity/pyproject.toml");
  assert.match(project, /^requires-python = ">=3\.12,<3\.13"$/m);
  assert.match(project, /^\s*"sqlglot==30\.15\.0",$/m);

  const lock = read("services/cloudflare-licensing-backend/scripts/pg-parity/uv.lock");
  assert.match(lock, /^requires-python = "==3\.12\.\*"$/m);
  assert.equal((lock.match(/^name = "sqlglot"$/gm) ?? []).length, 1);
  assert.equal((lock.match(/^version = "30\.15\.0"$/gm) ?? []).length, 1);
  assert.match(lock, /hash = "sha256:[0-9a-f]{64}"/);
});

test("maintained contributor entry points state the PostgreSQL parity prerequisites", () => {
  for (const path of ["AGENTS.md", "CONTRIBUTING.md", "README.md"]) {
    const content = read(path);
    assert.match(content, /Python 3\.12/);
    assert.match(content, /uv 0\.5\.15/);
  }

  const servicesWorkflow = read(".github/workflows/services.yml");
  assert.ok((servicesWorkflow.match(/uses: astral-sh\/setup-uv@/g) ?? []).length > 0);
  assert.doesNotMatch(servicesWorkflow, /working-directory:/);
});
