import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const RELEASE_OWNER_FILE = ".release-artifacts-owner";

export function realpath(value) {
  return realpathSync.native ? realpathSync.native(value) : realpathSync(value);
}

export function samePath(left, right) {
  const normalized = (value) => resolve(value).replaceAll("/", "\\").replace(/[\\/]+$/u, "");
  const first = normalized(left);
  const second = normalized(right);
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

export function pathWithin(child, parent, { allowEqual = false } = {}) {
  const distance = relative(resolve(parent), resolve(child));
  if (distance === "") return allowEqual;
  return distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}

export function nearestExistingAncestor(value) {
  let cursor = resolve(value);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (samePath(parent, cursor)) throw new Error(`no existing ancestor for release output: ${value}`);
    cursor = parent;
  }
  return cursor;
}

/** Reject symlink and Windows junction/reparse components before cleanup can touch them. */
export function assertNoReparseComponents(value) {
  const absolute = resolve(value);
  const parsed = parse(absolute);
  let cursor = parsed.root;
  const segments = relative(parsed.root, absolute).split(/[\\/]/u).filter(Boolean);
  for (const segment of segments) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) break;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`release output traverses a symlink or junction: ${cursor}`);
    if (process.platform === "win32" && !samePath(realpath(cursor), cursor)) {
      throw new Error(`release output traverses a reparse alias: ${cursor}`);
    }
  }
}

/** Validate both lexical and physical release-output containment. */
export function assertReleaseOutputBoundary({ root = repositoryRoot, outputDirectory, requireExists = false }) {
  const source = resolve(root);
  if (!existsSync(source)) throw new Error(`release source does not exist: ${source}`);
  const output = resolve(outputDirectory);
  const permitted = resolve(source, "build", "release-artifacts");
  const sourceReal = realpath(source);
  const lexicalInsideSource = pathWithin(output, source, { allowEqual: true });
  if (samePath(output, source) || (lexicalInsideSource && !pathWithin(output, permitted))) {
    throw new Error("release output must be outside the repository or beneath build/release-artifacts");
  }

  const ancestor = nearestExistingAncestor(output);
  assertNoReparseComponents(ancestor);
  const ancestorReal = realpath(ancestor);
  if (!lexicalInsideSource && pathWithin(ancestorReal, sourceReal, { allowEqual: true })) {
    throw new Error("release output resolves into the repository through an alias");
  }
  if (lexicalInsideSource && !pathWithin(ancestorReal, sourceReal, { allowEqual: true })) {
    throw new Error("release output leaves the repository through an alias");
  }

  if (requireExists) {
    if (!existsSync(output)) throw new Error(`release staging output does not exist: ${output}`);
    assertNoReparseComponents(output);
    const outputReal = realpath(output);
    if (lexicalInsideSource) {
      const permittedReal = realpath(permitted);
      if (!pathWithin(outputReal, permittedReal)) {
        throw new Error("release output escaped build/release-artifacts through an alias");
      }
    } else if (pathWithin(outputReal, sourceReal, { allowEqual: true })) {
      throw new Error("release output resolves into the repository through an alias");
    }
  }
  return { source, output, permitted };
}

function ownerText({ source, output }) {
  return `licensecc-release-artifacts-v1\n${source}\n${output}\n`;
}

function claimOwnedOutput({ root, outputDirectory }) {
  const verified = assertReleaseOutputBoundary({ root, outputDirectory, requireExists: true });
  const marker = join(verified.output, RELEASE_OWNER_FILE);
  writeFileSync(marker, ownerText(verified), { flag: "wx" });
  return { ...verified, marker, owner: ownerText(verified) };
}

export function prepareOwnedOutput({ root, outputDirectory }) {
  const boundary = assertReleaseOutputBoundary({ root, outputDirectory });
  if (existsSync(boundary.output)) throw new Error(`release staging output already exists: ${boundary.output}`);
  mkdirSync(boundary.output, { recursive: true });
  return claimOwnedOutput({ root, outputDirectory: boundary.output });
}

/** Keep MSVC's CMake probe short while still confining it below build/. */
export function prepareOwnedVerifierOutput(root) {
  const source = resolve(root);
  const parent = join(source, "build", "release-artifacts");
  const ancestor = nearestExistingAncestor(parent);
  assertNoReparseComponents(ancestor);
  mkdirSync(parent, { recursive: true });
  assertNoReparseComponents(parent);
  const output = mkdtempSync(join(parent, ".rv-"));
  try {
    return claimOwnedOutput({ root: source, outputDirectory: output });
  } catch (error) {
    if (existsSync(output) && !lstatSync(output).isSymbolicLink()) {
      rmSync(output, { recursive: true, force: true });
    }
    throw error;
  }
}

export function ownsStaging(staging) {
  try {
    const checked = assertReleaseOutputBoundary({
      root: staging.source,
      outputDirectory: staging.output,
      requireExists: true,
    });
    const marker = join(checked.output, RELEASE_OWNER_FILE);
    return lstatSync(marker).isFile() && readFileSync(marker, "utf8") === staging.owner;
  } catch {
    return false;
  }
}

export function removeOwnedChild(staging, child) {
  if (!pathWithin(child, staging.output) || !ownsStaging(staging) || !existsSync(child)) return;
  const stat = lstatSync(child);
  if (stat.isSymbolicLink()) throw new Error("owned release staging child became a symlink");
  rmSync(child, { recursive: true, force: true });
}

export function cleanupOwnedStaging(staging) {
  if (!staging || !ownsStaging(staging)) return;
  rmSync(staging.output, { recursive: true, force: true });
}
