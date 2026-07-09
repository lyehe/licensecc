import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Backend-specific structural token guards (Slice 2, L1 + L10). These are line-
// level regex checks, not simple secret needles, so they live outside the shared
// union scanner (repo-root scripts/secret-lint.mjs) and are invoked from the thin
// scripts/lint.mjs wrapper. Committed-secret marker scanning is now handled by
// the union set and is strictly broader than before: the former index.ts-only
// markers for raw PEM material, a hardcoded account-identifier assignment, and
// the API-token binding name are all subsumed and enforced across the whole tree.
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-worker", ".wrangler"]);

function* walk(root) {
  for (const entry of readdirSync(root)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      yield* walk(path);
    } else if (/\.(mjs|ts|js)$/.test(entry)) {
      yield path;
    }
  }
}

function lineIsComment(line) {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

// L1: token_prefix is DISPLAY-ONLY — it must NEVER appear in a WHERE / lookup comparison. Auth is
// token_hmac only. We flag `token_prefix` used as a comparison operand (=, IN, LIKE, <, >), which is
// the only way it could become a selector. token_prefix in an INSERT column list or SELECT
// projection (its legitimate display uses) has a comma/space after it, never a comparator, so those
// pass. This catches a fetch-by-prefix-then-=== regression at its root.
// Case-sensitive: the SQL column is lowercase `token_prefix`. A JS constant like `TOKEN_PREFIX`
// (the "lcca_" string prefix) is unrelated and must not trip this.
const L1_SELECTOR = /\btoken_prefix\b\s*(?:=|<|>|!=|<>|\bIN\b|\bLIKE\b|\bGLOB\b)/;

// L10: the raw token / Authorization header value must NEVER be passed to a logger
// (logEvent/logShadow/console.*) or written into the idempotency response, in the auth + token
// modules (the only code that handles the plaintext).
const AUTH_TOKEN_MODULES = [
  join(ROOT, "src", "auth", "account_token.mjs"),
  join(ROOT, "src", "auth", "account_auth.mjs"),
  join(ROOT, "scripts", "account-token.mjs"),
];
const SINK_CALL = /\b(?:console\.(?:log|error|warn|info|debug)|logEvent|logShadow|idempoten\w*Response|cacheResponse)\s*\(/;
const RAW_SECRET_IDENT = /\b(?:rawToken|raw|plaintext|bearer|tokenRaw)\b|[Aa]uthorization/;

/** Run the backend structural token guards; exits the process with code 1 on any violation. */
export function checkTokenGuards() {
  const scanRoots = [join(ROOT, "src"), join(ROOT, "scripts")];
  const sourceFiles = [];
  for (const dir of scanRoots) {
    for (const f of walk(dir)) sourceFiles.push(f);
  }

  const violations = [];

  for (const file of sourceFiles) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (lineIsComment(line)) return;
      if (L1_SELECTOR.test(line)) {
        violations.push(`L1: token_prefix used as a SQL selector (auth must be token_hmac only) in ${file}:${i + 1}\n    ${line.trim()}`);
      }
    });
  }

  for (const file of AUTH_TOKEN_MODULES) {
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue; // module not present in this checkout
    }
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (lineIsComment(line)) return;
      if (!SINK_CALL.test(line)) return;
      // Isolate the argument text after the sink call's opening paren, then STRIP only the LITERAL
      // text of strings — so a descriptive message ("...plaintext token...") does not false-positive,
      // while a real identifier argument (the actual secret value) is still seen. Crucially we PRESERVE
      // `${...}` interpolation expressions, so logging the secret via `token=${raw}` is still caught.
      let argText = line.slice(line.search(SINK_CALL));
      argText = argText.replace(/`((?:\\.|\$\{[^}]*\}|[^`\\])*)`/g, (_m, inner) => {
        const exprs = [...inner.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]).join(" ");
        return `\`${exprs}\``;
      });
      argText = argText.replace(/'(?:\\.|[^'\\])*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
      if (RAW_SECRET_IDENT.test(argText)) {
        violations.push(`L10: raw token / Authorization value passed to a log/idempotency sink in ${file}:${i + 1}\n    ${line.trim()}`);
      }
    });
  }

  if (violations.length > 0) {
    for (const v of violations) console.error(v);
    process.exit(1);
  }
}
