// Thin wrapper over the shared union secret scanner (repo-root scripts/secret-lint.mjs).
// Admin previously checked only three env-var-name needles, so a pasted
// `BEGIN PRIVATE KEY` block slipped through (finding 12). The union base set now
// enforces the same floor as every other service.
import { runSecretLint, SIGNING_KEY_NEEDLES } from "../../../scripts/secret-lint.mjs";

runSecretLint({ root: ".", label: "admin", extraNeedles: SIGNING_KEY_NEEDLES });
