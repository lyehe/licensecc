// Thin wrapper over the union committed-secret scan (repo-root scripts/secret-lint.mjs).
// The former index.ts-only API-token needle is preserved and now enforced tree-wide.
import { runSecretLint } from "../../../scripts/secret-lint.mjs";

runSecretLint({
  root: ".",
  label: "backend",
  extraNeedles: [["api", "token"].join("_")],
});
