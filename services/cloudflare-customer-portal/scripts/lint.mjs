// Thin wrapper over the shared union secret scanner (repo-root scripts/secret-lint.mjs).
// The portal never persists or commits a signing key, Cloudflare token, or pepper;
// the base union set already covers every marker the portal historically checked.
import { runSecretLint, SIGNING_KEY_NEEDLES } from "../../../scripts/secret-lint.mjs";

runSecretLint({ root: ".", label: "portal", extraNeedles: SIGNING_KEY_NEEDLES });
