import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const targets = Object.freeze([
  {
    env: "LICENSECC_BACKEND_WRANGLER_CONFIG_B64",
    path: "services/cloudflare-licensing-backend/wrangler.toml",
    required: [/name\s*=\s*"licensecc-online-verifier"/u, /binding\s*=\s*"DB"/u, /REQUEST_SIGNATURE_MODE\s*=\s*"required"/u, /ACCOUNT_TOKEN_MODE\s*=\s*"required"/u, /ORDER_INGEST_MODE\s*=\s*"required"/u],
  },
  {
    env: "LICENSECC_ADMIN_WRANGLER_CONFIG_B64",
    path: "services/cloudflare-license-admin/wrangler.jsonc",
    required: [/"name"\s*:\s*"licensecc-admin"/u, /"binding"\s*:\s*"DB"/u, /"ENVIRONMENT"\s*:\s*"production"/u, /"ADMIN_DEV_BEARER_ENABLED"\s*:\s*"0"/u],
  },
  {
    env: "LICENSECC_PORTAL_WRANGLER_CONFIG_B64",
    path: "services/cloudflare-customer-portal/wrangler.jsonc",
    required: [/"name"\s*:\s*"licensecc-customer-portal"/u, /"binding"\s*:\s*"DB"/u, /"ENVIRONMENT"\s*:\s*"production"/u, /"PORTAL_PUBLIC_ORIGIN"\s*:\s*"https:\/\//u, /"BACKEND_ORIGIN"\s*:\s*"https:\/\//u],
  },
  {
    env: "LICENSECC_BACKUP_WRANGLER_CONFIG_B64",
    path: "services/cloudflare-d1-backup/wrangler.jsonc",
    required: [/"name"\s*:\s*"licensecc-d1-backup"/u, /"binding"\s*:\s*"D1_BACKUP_WORKFLOW"/u, /"binding"\s*:\s*"BACKUP_BUCKET"/u],
  },
]);

const forbiddenAssignments = /(?:ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM|ORDER_HMAC_SECRETS|ACCOUNT_TOKEN_PEPPERS|EMERGENCY_OPERATOR_BEARER|WEBHOOK_SIGNING_SECRETS|PORTAL_OTP_PEPPERS|PORTAL_SESSION_PEPPERS|PORTAL_EMAIL_API_KEY|PORTAL_BOOTSTRAP_BEARER|D1_REST_API_TOKEN|BACKUP_TRIGGER_TOKEN)\s*[=:]/iu;

function strictBase64(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error(`${label} must be one strict base64 value`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) throw new Error(`${label} is not canonical base64`);
  return decoded;
}

function strictUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function activeConfigText(source) {
  let output = "";
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1] ?? "";
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      }
    } else if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        output += "  ";
        index += 1;
      } else {
        output += character === "\n" ? "\n" : " ";
      }
    } else if (quote) {
      output += character;
      if (character === "\\" && quote === '"') {
        output += next;
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
      output += character;
    } else if (character === "#") {
      lineComment = true;
      output += " ";
    } else if (character === "/" && next === "/") {
      lineComment = true;
      output += "  ";
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      output += "  ";
      index += 1;
    } else {
      output += character;
    }
  }
  if (quote || blockComment) throw new Error("production Wrangler configuration has an unterminated string or comment");
  return output;
}

function validateConfig(target, bytes) {
  const source = strictUtf8(bytes, target.env);
  if (source.includes("\0") || /replace-with|example\.(?:com|workers\.dev)/iu.test(source)) throw new Error(`${target.env} still contains an example placeholder`);
  const active = activeConfigText(source);
  if (forbiddenAssignments.test(active)) throw new Error(`${target.env} embeds a Worker secret instead of using wrangler secret storage`);
  for (const required of target.required) {
    if (!required.test(active)) throw new Error(`${target.env} is missing required production configuration ${required}`);
  }
  return bytes;
}

export function materializeDeploymentConfigs({ root = repositoryRoot, environment = process.env } = {}) {
  const prepared = targets.map((target) => ({
    bytes: validateConfig(target, strictBase64(environment[target.env], target.env)),
    destination: resolve(root, target.path),
  }));
  const written = [];
  try {
    for (const { bytes, destination } of prepared) {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
      written.push(destination);
    }
  } catch (error) {
    for (const destination of written.reverse()) {
      try {
        unlinkSync(destination);
      } catch {
        // Preserve the original write failure; every cleanup target was created by this invocation.
      }
    }
    throw error;
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const written = materializeDeploymentConfigs();
  console.log(`Materialized ${written.length} production Wrangler configurations.`);
}
