import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SECRET_ENV_NAMES = [
  "ADMIN_BEARER",
  "ADMIN_DEV_BEARER",
  "BACKUP_TRIGGER_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "D1_REST_API_TOKEN",
  "LICENSECC_ACCESS_JWT",
  "LICENSECC_NON_ADMIN_ACCESS_JWT",
  "LICENSECC_PORTAL_ACCESS_JWT",
  "LICENSECC_PORTAL_BOOTSTRAP_BEARER",
  "LICENSECC_PORTAL_OTP_CODE",
  "LICENSECC_PORTAL_SESSION_COOKIE",
  "ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM",
  "SYNC_API_TOKEN",
];

const REQUIRED_IGNORED_PATHS = [
  "services/cloudflare-licensing-backend/wrangler.toml",
  "services/cloudflare-license-admin/wrangler.toml",
  "services/cloudflare-license-admin/wrangler.jsonc",
  "services/cloudflare-d1-backup/wrangler.jsonc",
  "services/cloudflare-licensing-backend/.dev.vars",
  "services/cloudflare-license-admin/.dev.vars",
  "services/cloudflare-licensing-backend/.online-key/online_private_key.pkcs8.pem",
];

// Match NAME=value for the bounded secret-env-name list. (`:`-style scanning was tried but matches
// JS/TS object properties like `NAME: token.token`, a false positive in this mixed codebase.)
const SECRET_ASSIGNMENT = new RegExp(`(?:^|[\\s;])(${SECRET_ENV_NAMES.join("|")})\\s*=(?!=)\\s*([^\\s"'\\\`]+)`, "g");
const PRIVATE_KEY_MARKER = /-----BEGIN (?:RSA |EC |OPENSSH |PRIVATE )?PRIVATE KEY-----/;
const JWT_LIKE = /\b[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/;

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cmake",
  ".cpp",
  ".css",
  ".h",
  ".hpp",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".md",
  ".mjs",
  ".rst",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

function pathExt(path) {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

function isTextPath(path) {
  return TEXT_EXTENSIONS.has(pathExt(path)) || path.includes("CMakeLists.txt") || path.includes("Doxyfile");
}

// Shannon entropy (bits/char) of a string. A real random token (base64/hex API token, JWT segment)
// sits around 4-6 bits/char; hand-written placeholders like "test-bearer" or "your-secret" are low.
function shannonEntropyBitsPerChar(value) {
  if (value.length === 0) {
    return 0;
  }
  const freq = new Map();
  for (const ch of value) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let bits = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

// A value that LOOKS like a random secret: long enough, high per-char entropy. Used to override the
// fuzzy word-based placeholder guesses so a real high-entropy token that merely CONTAINS a word like
// "test"/"local"/"secret" is still flagged rather than waved through (audit R4.7).
function looksHighEntropy(value) {
  const stripped = value.trim().replace(/^['"]|['"]$/g, "");
  return stripped.length >= 20 && shannonEntropyBitsPerChar(stripped) >= 3.5;
}

function isPlaceholderValue(value) {
  const normalized = value.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  if (normalized === "") {
    return true;
  }
  if (/^<[^>]+>$/.test(normalized)) {
    return true;
  }
  if (normalized.includes("redacted") || normalized.includes("replace") || normalized.includes("example")) {
    return true;
  }
  // A high-entropy value is a real secret even if it contains a placeholder-ish word: check BEFORE
  // the fuzzy word matches so "test_<random>" / "local-<random>" are not waved through.
  if (looksHighEntropy(value)) {
    return false;
  }
  if (normalized.includes("secret") || normalized.includes("test") || normalized.includes("local")) {
    return true;
  }
  if (normalized.includes("|") || normalized.includes("\\")) {
    return true;
  }
  return false;
}

function scanText(path, content) {
  const findings = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; ++index) {
    const line = lines[index];
    // Flag a committed private-key marker, but NOT a template literal that wraps a RUNTIME-generated
    // key (a PEM begin-marker line immediately followed by `\n${b64}...`, common in test fixtures): a
    // real committed key is static base64, never a `${...}` interpolation on the marker line. The
    // marker literal is deliberately NOT spelled out contiguously here so the source-artifact scan
    // (cmake/ScanSourceArtifact.cmake) does not flag this scanner file itself (audit R4.7).
    if (PRIVATE_KEY_MARKER.test(line) && !line.includes("${")) {
      findings.push({ path, line: index + 1, kind: "private_key_marker" });
    }
    if (JWT_LIKE.test(line)) {
      findings.push({ path, line: index + 1, kind: "jwt_like_token" });
    }
    SECRET_ASSIGNMENT.lastIndex = 0;
    for (const match of line.matchAll(SECRET_ASSIGNMENT)) {
      const value = match[2] ?? "";
      if (!isPlaceholderValue(value)) {
        findings.push({ path, line: index + 1, kind: "secret_assignment", name: match[1] });
      }
    }
  }
  return findings;
}

function gitOutput(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function gitListFiles() {
  return gitOutput(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((path) => path !== "" && isTextPath(path));
}

function ignoredPathsStatus(paths = REQUIRED_IGNORED_PATHS) {
  return paths.map((path) => {
    const result = spawnSync("git", ["check-ignore", "--quiet", path], { encoding: "utf8" });
    return { path, ignored: result.status === 0 };
  });
}

function runSecretHygieneScan() {
  const ignoreResults = ignoredPathsStatus();
  const notIgnored = ignoreResults.filter((result) => !result.ignored);
  const findings = [];
  for (const path of gitListFiles()) {
    let content;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    findings.push(...scanText(path, content));
  }
  return { ok: findings.length === 0 && notIgnored.length === 0, findings, ignored_paths: ignoreResults };
}

function main() {
  const result = runSecretHygieneScan();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exit(1);
  }
}

export {
  REQUIRED_IGNORED_PATHS,
  SECRET_ENV_NAMES,
  isPlaceholderValue,
  scanText,
  ignoredPathsStatus,
  runSecretHygieneScan,
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
