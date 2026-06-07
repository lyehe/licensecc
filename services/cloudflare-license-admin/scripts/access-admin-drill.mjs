import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  runAccessAdminValidation,
  validateOptions as validateAccessOptions,
} from "./validate-access-admin.mjs";

const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/;

function usage(exitCode = 2) {
  console.error(`usage:
  node scripts/access-admin-drill.mjs --url <admin-worker-url> [--use-cloudflared] [--login] [--cloudflared-bin cloudflared] [--project DEFAULT] [--feature DEFAULT] [--fingerprint <64-hex>]

The drill reads LICENSECC_ACCESS_JWT when present. Otherwise, pass
--use-cloudflared or set LICENSECC_ACCESS_USE_CLOUDFLARED=1 to read a cached
Cloudflare Access application token with cloudflared. Pass --login to launch the
Access login flow before reading the cached token. Tokens are not printed and
are not passed on the process command line.`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 2; index < argv.length; ++index) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--use-cloudflared") {
      options.useCloudflared = true;
      continue;
    }
    if (arg === "--login") {
      options.login = true;
      options.useCloudflared = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    options[arg.slice(2)] = value;
  }
  return options;
}

function boolEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function extractJwt(text) {
  const match = JWT_RE.exec(String(text ?? ""));
  return match?.[0] ?? null;
}

function validateDrillOptions(options, env = process.env) {
  if (options.help) {
    usage(0);
  }
  const rawUrl = options.url ?? env.LICENSECC_ADMIN_URL;
  const baseUrl = new URL(requiredString(rawUrl, "url"));
  return {
    baseUrl,
    project: options.project ?? "DEFAULT",
    feature: options.feature ?? "DEFAULT",
    fingerprint: options.fingerprint,
    cloudflaredBin: options["cloudflared-bin"] ?? "cloudflared",
    appUrl: options.app ?? baseUrl.toString(),
    useCloudflared: options.useCloudflared === true || boolEnv(env.LICENSECC_ACCESS_USE_CLOUDFLARED),
    login: options.login === true,
  };
}

function readAccessJwt(options, env = process.env, execFile = execFileSync) {
  if (typeof env.LICENSECC_ACCESS_JWT === "string" && env.LICENSECC_ACCESS_JWT !== "") {
    return { token: env.LICENSECC_ACCESS_JWT, source: "env" };
  }
  if (options.useCloudflared !== true) {
    throw new Error("LICENSECC_ACCESS_JWT is missing; set it or pass --use-cloudflared after cloudflared access login");
  }
  const app = requiredString(options.appUrl, "app url");
  if (options.login) {
    execFile(options.cloudflaredBin, ["access", "login", "--quiet", "--auto-close", "--app", app], {
      encoding: "utf8",
      stdio: "inherit",
    });
  }
  let output = "";
  try {
    output = execFile(options.cloudflaredBin, ["access", "token", "--app", app], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error(`could not read cached Cloudflare Access token; run: cloudflared access login --quiet --auto-close --app ${app}`);
  }
  const token = extractJwt(output);
  if (token === null) {
    throw new Error(`cloudflared did not return an Access JWT; run: cloudflared access login --quiet --auto-close --app ${app}`);
  }
  return { token, source: "cloudflared" };
}

async function runAccessAdminDrill(options, env = process.env, execFile = execFileSync) {
  const token = readAccessJwt(options, env, execFile);
  const validationOptions = validateAccessOptions({
    url: options.baseUrl.toString(),
    project: options.project,
    feature: options.feature,
    fingerprint: options.fingerprint,
  }, {
    LICENSECC_ACCESS_JWT: token.token,
    LICENSECC_NON_ADMIN_ACCESS_JWT: env.LICENSECC_NON_ADMIN_ACCESS_JWT,
  });
  const summary = await runAccessAdminValidation(validationOptions);
  return {
    ...summary,
    access_token_source: token.source,
  };
}

async function main() {
  const options = validateDrillOptions(parseArgs(process.argv));
  const summary = await runAccessAdminDrill(options);
  console.log(JSON.stringify(summary, null, 2));
}

export {
  extractJwt,
  parseArgs,
  readAccessJwt,
  runAccessAdminDrill,
  validateDrillOptions,
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
