// Thin wrapper over the shared union secret scanner (repo-root scripts/secret-lint.mjs).
// The backup service's historical markers (D1 REST token, backup trigger token,
// account_id, PEM material, and the committed-JWT regex) are all in the base union set.
import { runSecretLint, SIGNING_KEY_NEEDLES } from "../../../scripts/secret-lint.mjs";

runSecretLint({ root: ".", label: "backup", extraNeedles: SIGNING_KEY_NEEDLES });
