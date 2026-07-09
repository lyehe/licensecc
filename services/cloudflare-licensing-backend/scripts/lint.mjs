// Thin wrapper: union committed-secret scan (repo-root scripts/secret-lint.mjs)
// plus the backend's structural token guards (L1 + L10, in token-guards.mjs). The
// former index.ts-only `api_token` needle is preserved and now enforced tree-wide.
// excludeFiles: two tests wrap an EPHEMERAL runtime keypair in a PEM envelope
// (`-----BEGIN PRIVATE KEY-----\n${b64}...`) — generated in-memory, never committed.
import { runSecretLint } from "../../../scripts/secret-lint.mjs";
import { checkTokenGuards } from "./token-guards.mjs";

checkTokenGuards();
runSecretLint({
  root: ".",
  label: "backend",
  extraNeedles: [["api", "token"].join("_")],
  excludeFiles: ["test/fulfillment/account_isolation.test.mjs", "test/sql/trial-activation.test.mjs"],
});
