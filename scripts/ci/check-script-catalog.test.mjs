import assert from "node:assert/strict";
import test from "node:test";

import { evaluateScriptCatalog } from "./check-script-catalog.mjs";

function catalog(paths = ["scripts/a.mjs", "scripts/ci/b.mjs"]) {
  return {
    schema_version: 1,
    categories: [
      { id: "repository-hygiene", purpose: "Repository organization and local diagnostics.", paths },
    ],
  };
}

test("exact one-category script inventory passes", () => {
  assert.deepEqual(evaluateScriptCatalog(catalog(), ["scripts/a.mjs", "scripts/ci/b.mjs"]), []);
});

test("uncategorized and stale script paths fail", () => {
  const errors = evaluateScriptCatalog(catalog(["scripts/stale.mjs"]), ["scripts/new.mjs"]);
  assert.deepEqual(errors.map(({ code }) => code), ["SCRIPT_CATALOG_MISSING", "SCRIPT_CATALOG_STALE"]);
});

test("duplicate categories and paths fail deterministically", () => {
  const value = catalog(["scripts/a.mjs"]);
  value.categories.push({
    id: "repository-hygiene",
    purpose: "A second invalid ownership category.",
    paths: ["scripts/a.mjs"],
  });
  const errors = evaluateScriptCatalog(value, ["scripts/a.mjs"]);
  assert.deepEqual(errors.map(({ code }) => code), ["SCRIPT_CATALOG_DUPLICATE_CATEGORY", "SCRIPT_CATALOG_DUPLICATE_PATH"]);
});

test("invalid schema, category metadata, and paths fail closed", () => {
  const value = {
    schema_version: 2,
    categories: [{ id: "Bad Category", purpose: "short", paths: ["../escape.mjs"] }],
  };
  const codes = evaluateScriptCatalog(value, []).map(({ code }) => code);
  assert.deepEqual(codes, [
    "SCRIPT_CATALOG_CATEGORY_ID",
    "SCRIPT_CATALOG_PATH",
    "SCRIPT_CATALOG_PURPOSE",
    "SCRIPT_CATALOG_SCHEMA",
  ]);
});
