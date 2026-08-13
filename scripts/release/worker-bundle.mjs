import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

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

function workerTokens(source) {
  const tokens = [];
  const regexMayStartAfter = new Set(["(", "[", "{", ",", ";", ":", "=", "!", "?", "&", "|", "+", "-", "*", "%", "^", "~", "<", ">", "return", "throw", "case", "delete", "void", "typeof", "new", "in", "of", "yield", "await"]);
  const skipQuoted = (cursor, quote) => {
    for (let index = cursor + 1; index < source.length; index += 1) {
      if (source[index] === "\\") index += 1;
      else if (source[index] === quote) return index + 1;
    }
    return source.length;
  };
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    const next = source[cursor + 1];
    if (/\s/u.test(character)) {
      cursor += 1;
    } else if (character === "/" && next === "/") {
      const end = source.indexOf("\n", cursor + 2);
      cursor = end === -1 ? source.length : end + 1;
    } else if (character === "/" && next === "*") {
      const end = source.indexOf("*/", cursor + 2);
      cursor = end === -1 ? source.length : end + 2;
    } else if (character === '"' || character === "'") {
      let value = "";
      let index = cursor + 1;
      for (; index < source.length; index += 1) {
        if (source[index] === "\\") {
          value += source[index + 1] ?? "";
          index += 1;
        } else if (source[index] === character) {
          index += 1;
          break;
        } else {
          value += source[index];
        }
      }
      tokens.push({ kind: "string", value });
      cursor = index;
    } else if (character === "`") {
      cursor = skipQuoted(cursor, "`");
    } else if (character === "/" && regexMayStartAfter.has(tokens.at(-1)?.value)) {
      cursor = skipQuoted(cursor, "/");
      while (/[A-Za-z]/u.test(source[cursor] ?? "")) cursor += 1;
    } else if (/[A-Za-z_$]/u.test(character)) {
      const match = /^[A-Za-z_$][\w$]*/u.exec(source.slice(cursor));
      tokens.push({ kind: "identifier", value: match[0] });
      cursor += match[0].length;
    } else {
      tokens.push({ kind: "punctuator", value: character });
      cursor += 1;
    }
  }
  return tokens;
}

/** Ask Node's module parser for exports without evaluating the bundle. */
function moduleExportsDefault(source) {
  const inspector = [
    'import vm from "node:vm";',
    'import { readFileSync } from "node:fs";',
    'const source = readFileSync(0, "utf8");',
    'const module = new vm.SourceTextModule(source);',
    'await module.link(() => { throw new Error("static import is not expected in a Worker bundle"); });',
    'process.stdout.write(JSON.stringify(Object.getOwnPropertyNames(module.namespace)));',
  ].join("");
  const parsed = spawnSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", inspector], {
    input: source,
    encoding: "utf8",
    windowsHide: true,
  });
  if (parsed.error || parsed.status !== 0) return false;
  try {
    return JSON.parse(parsed.stdout).includes("default");
  } catch {
    return false;
  }
}

function hasWorkerEntrypoint(source) {
  if (moduleExportsDefault(source)) return true;
  const tokens = workerTokens(source);
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === "{") {
      depth += 1;
      continue;
    }
    if (token.value === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    if (token.value === "export" && tokens[index + 1]?.value === "default") return true;
    if (token.value === "export" && tokens[index + 1]?.value === "{") {
      let braceDepth = 0;
      for (let position = index + 1; position < tokens.length; position += 1) {
        if (tokens[position].value === "{") braceDepth += 1;
        else if (tokens[position].value === "}") {
          braceDepth -= 1;
          if (braceDepth === 0) break;
        } else if (braceDepth === 1 && (tokens[position].value === "default" || (tokens[position].value === "as" && tokens[position + 1]?.value === "default"))) {
          return true;
        }
      }
    }
    if (token.value === "addEventListener" && tokens[index + 1]?.value === "(" && tokens[index + 2]?.kind === "string" && tokens[index + 2]?.value === "fetch") {
      return true;
    }
  }
  return false;
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
