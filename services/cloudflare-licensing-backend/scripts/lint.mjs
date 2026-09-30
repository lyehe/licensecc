// Thin wrapper: union committed-secret scan (repo-root scripts/secret-lint.mjs)
// plus the backend's structural token guards (L1 + L10, in token-guards.mjs). The
// former index.ts-only API-token needle is preserved and now enforced tree-wide.
import { runSecretLint } from "../../../scripts/secret-lint.mjs";
import { checkTokenGuards } from "./token-guards.mjs";

checkTokenGuards();
runSecretLint({
  root: ".",
  label: "backend",
  extraNeedles: [["api", "token"].join("_")],
});
