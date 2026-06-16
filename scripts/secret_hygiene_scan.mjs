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
    if (PRIVATE_KEY_MARKER.test(line)) {
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
