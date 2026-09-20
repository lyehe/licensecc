import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "acorn";

const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
const parsedWorkerSources = new Map();

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function ordinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function strictUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

/** Parse, but never execute, a module bundle with the same Node parser used by release tooling. */
function parseWorkerModule(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BUNDLE_BYTES) {
    throw new Error(`${label} is empty or too large`);
  }
  const cacheKey = sha256(bytes);
  const cached = parsedWorkerSources.get(cacheKey);
  if (cached !== undefined) return cached;
  const source = strictUtf8(bytes, label);
  const parsed = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: source,
    encoding: "utf8",
    windowsHide: true,
  });
  if (parsed.error || parsed.status !== 0) throw new Error(`${label} does not parse as an ES module`);
  if (parsedWorkerSources.size < 256) parsedWorkerSources.set(cacheKey, source);
  return source;
}

/** Inspect syntax only: Cloudflare runtime imports cannot be linked in Node. */
function hasWorkerEntrypoint(source) {
  const module = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  return module.body.some((statement) => {
    if (statement.type === "ExportDefaultDeclaration") return true;
    if (statement.type === "ExportNamedDeclaration") {
      return statement.specifiers.some(({ exported }) => (exported.name ?? exported.value) === "default");
    }
    const call = statement.type === "ExpressionStatement" ? statement.expression : null;
    return call?.type === "CallExpression"
      && call.callee.type === "Identifier" && call.callee.name === "addEventListener"
      && call.arguments[0]?.type === "Literal" && call.arguments[0].value === "fetch";
  });
}

/** Require a parsed non-empty JavaScript bundle and an explicit Worker fetch/module entrypoint. */
export function validateWorkerBundle(directory, label = "Worker bundle") {
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) {
    throw new Error(`${label} directory is missing or unsafe`);
  }
  const javascript = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => ordinal(left.name, right.name))) {
      const child = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && /\.(?:mjs|cjs|js)$/iu.test(entry.name)) javascript.push(child);
      else if (!entry.isFile()) throw new Error(`${label} contains an unsupported filesystem entry`);
    }
  };
  visit(directory);
  if (javascript.length === 0) throw new Error(`${label} has no JavaScript entrypoint`);
  const sources = javascript.map((file) => parseWorkerModule(readFileSync(file), `${label} ${relative(directory, file)}`));
  if (!sources.some(hasWorkerEntrypoint)) {
    throw new Error(`${label} has no Worker fetch or module default entrypoint`);
  }
}
