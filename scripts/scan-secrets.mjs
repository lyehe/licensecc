import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSecretLint, SIGNING_KEY_NEEDLES } from "./secret-lint.mjs";
import { checkTokenGuards } from "../services/cloudflare-licensing-backend/scripts/token-guards.mjs";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

// These are source fixtures that construct a transient keypair at runtime.  The
// scanner still reads every other tracked file in the superproject; a submodule
// gitlink is skipped by the scanner because it is a directory, not a source file.
const REPOSITORY_EXCLUSIONS = [
  "scripts/secret-lint.mjs",
  "scripts/secret-lint.test.mjs",
  "services/cloudflare-licensing-backend/test/fulfillment/account_isolation.test.mjs",
  "services/cloudflare-licensing-backend/test/sql/trial-activation.test.mjs",
];

checkTokenGuards();
runSecretLint({
  root: REPOSITORY_ROOT,
  label: "repository",
  excludeFiles: REPOSITORY_EXCLUSIONS,
});

// The private signing-key binding names are forbidden outside the backend.  Run
// the extra policy against each whole tracked service tree after the repository
// union scan so root/package/docs files are covered too.
for (const service of [
  ["cloudflare-license-admin", "admin"],
  ["cloudflare-customer-portal", "portal"],
  ["cloudflare-d1-backup", "backup"],
]) {
  const [directory, label] = service;
  runSecretLint({
    root: join(REPOSITORY_ROOT, "services", directory),
    label,
    extraNeedles: SIGNING_KEY_NEEDLES,
  });
}
