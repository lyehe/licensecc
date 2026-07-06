import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Existing guard: no committed secret markers in the Worker entry point.
// ---------------------------------------------------------------------------

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const forbidden = [
  "PRIVATE KEY-----\\n",
  "account_id =",
  "api_token",
];

for (const needle of forbidden) {
  if (indexSource.includes(needle)) {
    throw new Error(`forbidden committed secret marker found: ${needle}`);
  }
}

// ---------------------------------------------------------------------------
// Slice 2 account-token guards (L1 + L10). Scan src/ + scripts/.
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

const scanRoots = [join(ROOT, "src"), join(ROOT, "scripts")];
const sourceFiles = [];
for (const dir of scanRoots) {
  for (const f of walk(dir)) sourceFiles.push(f);
}

function lineIsComment(line) {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

const violations = [];

// L1: token_prefix is DISPLAY-ONLY — it must NEVER appear in a WHERE / lookup comparison. Auth is
// token_hmac only. We flag `token_prefix` used as a comparison operand (=, IN, LIKE, <, >), which is
// the only way it could become a selector. token_prefix in an INSERT column list or SELECT
// projection (its legitimate display uses) has a comma/space after it, never a comparator, so those
// pass. This catches a fetch-by-prefix-then-=== regression at its root.
// Case-sensitive: the SQL column is lowercase `token_prefix`. A JS constant like `TOKEN_PREFIX`
// (the "lcca_" string prefix) is unrelated and must not trip this.
const L1_SELECTOR = /\btoken_prefix\b\s*(?:=|<|>|!=|<>|\bIN\b|\bLIKE\b|\bGLOB\b)/;

for (const file of sourceFiles) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (lineIsComment(line)) return;
    if (L1_SELECTOR.test(line)) {
      violations.push(`L1: token_prefix used as a SQL selector (auth must be token_hmac only) in ${file}:${i + 1}\n    ${line.trim()}`);
    }
  });
}

// L10: the raw token / Authorization header value must NEVER be passed to a logger
// (logEvent/logShadow/console.*) or written into the idempotency response, in the auth + token
// modules (the only code that handles the plaintext). We flag a logging/idempotency call whose
// arguments reference a known raw-secret identifier. The safe display value `token_prefix` and the
// safe fields (customer_id, code, project, feature, request_id) are allowed.
const AUTH_TOKEN_MODULES = [
  join(ROOT, "src", "auth", "account_token.mjs"),
  join(ROOT, "src", "auth", "account_auth.mjs"),
  join(ROOT, "scripts", "account-token.mjs"),
];

// A logging / idempotency-response sink call.
const SINK_CALL = /\b(?:console\.(?:log|error|warn|info|debug)|logEvent|logShadow|idempoten\w*Response|cacheResponse)\s*\(/;
// A raw-secret identifier as a whole word (the plaintext token / bearer / Authorization header).
const RAW_SECRET_IDENT = /\b(?:rawToken|raw|plaintext|bearer|tokenRaw)\b|[Aa]uthorization/;
// The plaintext-print path is allowed to write the secret to stdout/--out (NOT a logger): process
// .stdout.write of the plaintext is the one-time-print, explicitly outside the log/idempotency sink.

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
    // Replace ${...} expressions with a visible marker that keeps the inner identifiers exposed.
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

console.log("lint ok");
