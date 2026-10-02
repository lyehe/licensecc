// Renders src/library/device_identity/bound_label_table.hpp, the native client's copy of the
// device-label rule, from the licensing backend's rule in
// services/cloudflare-licensing-backend/src/device/device_label.mjs and its confusables subset in
// device_label_confusables.mjs. The backend owns the rule; this tool only expands its property
// escapes into code-point ranges and copies its skeleton fold and code skeletons, so the native
// client refuses the same labels before it sends one. It also derives that confusables subset from
// the pinned Unicode confusables.txt (UTS #39), when asked to.
//
//   node scripts/generate-device-label-table.mjs           check the committed table and subset
//   node scripts/generate-device-label-table.mjs --write   regenerate the table
//   node scripts/generate-device-label-table.mjs --write --confusables <path or https URL>
//       read or download confusables.txt, require its pinned SHA-256, rewrite the committed
//       subset from it, then regenerate the table
//
// The ranges come from the running engine's Unicode data. A table generated with newer data
// than the running engine still passes the check when every code point the two disagree on is
// unassigned in the running engine; a newer engine asks for the table to be regenerated. The
// confusables come only from the committed subset, so a check or a plain --write never reads the
// network, and they must match exactly whatever the engine.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEVICE_LABEL_REFUSED,
  DEVICE_LABEL_SEPARATOR,
  FULLWIDTH_ASCII,
} from "../services/cloudflare-licensing-backend/src/device/device_label.mjs";
import {
  DEVICE_LABEL_CODE_SKELETONS,
  DEVICE_LABEL_CONFUSABLES,
  DEVICE_LABEL_CONFUSABLES_SOURCE,
} from "../services/cloudflare-licensing-backend/src/device/device_label_confusables.mjs";

/** The committed subset: the code skeletons and the code points that fold to them. */
const COMMITTED_SUBSET = Object.freeze({ skeletons: DEVICE_LABEL_CODE_SKELETONS, confusables: DEVICE_LABEL_CONFUSABLES });

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const TABLE_PATH = "src/library/device_identity/bound_label_table.hpp";
export const CONFUSABLES_PATH = "services/cloudflare-licensing-backend/src/device/device_label_confusables.mjs";
const LAST_CODE_POINT = 0x10ffff;
const UNASSIGNED = /\p{Cn}/u;

/**
 * The upstream file the confusables subset is derived from. Adopting a new Unicode version means
 * changing all three values together and regenerating with --confusables.
 */
export const CONFUSABLES_SOURCE = Object.freeze({
  unicode: "17.0.0",
  url: "https://www.unicode.org/Public/17.0.0/security/confusables.txt",
  sha256: "091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a",
});

/** The comparison-code alphabet [0-9A-Fa-f-], in the order JavaScript enumerates it as keys. */
const CODE_ALPHABET = "0123456789ABCDEFabcdef-";

/** Inclusive [first, last] ranges of the Unicode scalar values that `pattern` matches. */
export function codePointRanges(pattern) {
  const ranges = [];
  for (let point = 0; point <= LAST_CODE_POINT; point += 1) {
    if (point >= 0xd800 && point <= 0xdfff) continue; // surrogates never occur in valid UTF-8
    if (!pattern.test(String.fromCodePoint(point))) continue;
    const last = ranges.at(-1);
    if (last !== undefined && last[1] === point - 1) last[1] = point;
    else ranges.push([point, point]);
  }
  return ranges;
}

const hex = (value) => `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;
const rows = (ranges) => ranges.map(([first, last]) => `\t{${hex(first)}, ${hex(last)}},`).join("\n");

/** The distinct skeletons of the code alphabet, in code-alphabet order. */
function skeletonOrder(skeletons) {
  return [...new Set([...CODE_ALPHABET].map((character) => skeletons[character]))];
}

/** The skeletons of the code digits and letters, without the dash, as one string. */
function codeSkeletons(skeletons) {
  return skeletonOrder(skeletons).filter((skeleton) => skeleton !== "-").join("");
}

/** [code point, skeleton] pairs of the confusables, in code-point order. */
function foldPairs(confusables) {
  return Object.entries(confusables)
    .flatMap(([skeleton, points]) => points.map((point) => [point, skeleton]))
    .sort((left, right) => left[0] - right[0]);
}

function foldRows(confusables) {
  const pairs = foldPairs(confusables).map(([point, skeleton]) => `{${hex(point)}, '${skeleton}'},`);
  const lines = [];
  for (let start = 0; start < pairs.length; start += 6) lines.push(`\t${pairs.slice(start, start + 6).join(" ")}`);
  return lines.join("\n");
}

/** The table for the running engine's Unicode data, labelled with `unicode`. */
export function renderDeviceLabelTable(unicode = process.versions.unicode, subset = COMMITTED_SUBSET,
  source = DEVICE_LABEL_CONFUSABLES_SOURCE) {
  return `// Generated by scripts/generate-device-label-table.mjs from the device-label rule in
// services/cloudflare-licensing-backend/src/device/device_label.mjs, with Unicode ${unicode} data.
// Do not edit: run \`node scripts/generate-device-label-table.mjs --write\` and commit the result.
#pragma once
#include <cstdint>

namespace license {
namespace device_identity {
namespace bound_label_table {
struct Range {
	std::uint32_t first;
	std::uint32_t last;
};
// A code point and the skeleton it is folded to.
struct Fold {
	std::uint32_t point;
	char to;
};
// Fullwidth ASCII folds to ASCII by subtracting the offset.
inline constexpr std::uint32_t fullwidth_first = ${hex(FULLWIDTH_ASCII.first)};
inline constexpr std::uint32_t fullwidth_last = ${hex(FULLWIDTH_ASCII.last)};
inline constexpr std::uint32_t fullwidth_offset = ${hex(FULLWIDTH_ASCII.offset)};
// clang-format off
// Refused anywhere in a label: ${DEVICE_LABEL_REFUSED.source}
inline constexpr Range refused[] = {
${rows(codePointRanges(DEVICE_LABEL_REFUSED))}
};
// Separators mapped to '-' in the comparison form: ${DEVICE_LABEL_SEPARATOR.source}
inline constexpr Range separators[] = {
${rows(codePointRanges(DEVICE_LABEL_SEPARATOR))}
};
// The skeletons of the comparison-code digits and letters [0-9A-Fa-f] in Unicode confusables.txt
// ${source.unicode} (UTS #39): a label's skeleton must not hold three groups of four of these joined by '-'.
inline constexpr char code_skeletons[] = "${codeSkeletons(subset.skeletons)}";
// Code points whose confusable prototype is the skeleton of a comparison-code character, folded to
// that skeleton; copied from device_label_confusables.mjs, by code point.
inline constexpr Fold confusables[] = {
${foldRows(subset.confusables)}
};
// clang-format on
}  // namespace bound_label_table
}  // namespace device_identity
}  // namespace license
`;
}

/** The Unicode version, the two range lists and the confusables fold of a rendered table. */
export function parseDeviceLabelTable(text) {
  const body = (declaration) => {
    const start = text.indexOf(declaration);
    return start === -1 ? null : text.slice(start, text.indexOf("\n};", start));
  };
  const block = (name) => {
    const found = body(`Range ${name}[] = {`);
    return found === null ? null : [...found.matchAll(/\{(0x[0-9A-F]+), (0x[0-9A-F]+)\}/g)].map((match) => [Number(match[1]), Number(match[2])]);
  };
  const folds = body("Fold confusables[] = {");
  return {
    unicode: /with Unicode (\S+) data\./.exec(text)?.[1] ?? null,
    refused: block("refused"),
    separators: block("separators"),
    skeletons: /code_skeletons\[\] = "([^"]*)";/.exec(text)?.[1] ?? null,
    confusables: folds === null ? null : [...folds.matchAll(/\{(0x[0-9A-F]+), '(.)'\}/g)].map((match) => [Number(match[1]), match[2]]),
  };
}

function expand(ranges) {
  const points = new Set();
  for (const [first, last] of ranges) for (let point = first; point <= last; point += 1) points.add(point);
  return points;
}

/** Code points the two range lists disagree on that `isUnassigned` does not explain, ascending. */
export function unexplainedDifference(committed, current, isUnassigned = (point) => UNASSIGNED.test(String.fromCodePoint(point))) {
  const left = expand(committed);
  const right = expand(current);
  const differing = [...left].filter((point) => !right.has(point)).concat([...right].filter((point) => !left.has(point)));
  return differing.filter((point) => !isUnassigned(point)).sort((a, b) => a - b);
}

/** Problems with the committed table text, or an empty list when it matches the rule. */
export function deviceLabelTableDrift(checkedOutText, unicode = process.versions.unicode) {
  // A Windows checkout may carry CRLF line endings; the committed blob is LF.
  const committedText = checkedOutText.replace(/\r\n/gu, "\n");
  const regenerate = `run node scripts/generate-device-label-table.mjs --write with Unicode ${unicode} data and commit ${TABLE_PATH}`;
  const committed = parseDeviceLabelTable(committedText);
  if (committed.unicode === null || committed.refused === null || committed.separators === null || committed.skeletons === null
      || committed.confusables === null) {
    return [`${TABLE_PATH} is not a generated table; ${regenerate}`];
  }
  const expected = renderDeviceLabelTable(committed.unicode);
  if (committed.unicode === unicode) return committedText === expected ? [] : [`${TABLE_PATH} differs from the backend rule; ${regenerate}`];
  const withoutRows = (text) => text.split("\n").filter((line) => !/^\t\{0x/.test(line)).join("\n");
  const problems = [];
  if (withoutRows(committedText) !== withoutRows(expected)) problems.push(`${TABLE_PATH} differs from the generator output outside its ranges; ${regenerate}`);
  const current = parseDeviceLabelTable(expected);
  for (const name of ["refused", "separators"]) {
    const unexplained = unexplainedDifference(committed[name], current[name]);
    if (unexplained.length > 0) {
      problems.push(`${name} differs from this engine's Unicode ${unicode} data on assigned code points ${unexplained.slice(0, 8).map(hex).join(", ")}; ${regenerate}`);
    }
  }
  // The fold comes from pinned data, not from the engine, so no engine difference excuses it.
  if (JSON.stringify(committed.confusables) !== JSON.stringify(current.confusables)) {
    problems.push(`confusables differ from ${CONFUSABLES_PATH}; ${regenerate}`);
  }
  return problems;
}

/**
 * The part of a confusables.txt text's UTS #39 skeleton that can spell a comparison code:
 * `skeletons`, the prototype of each character of the code alphabet [0-9A-Fa-f-] (the character
 * itself when the file does not map it), and `confusables`, every code point whose prototype is one
 * of those skeletons, grouped by that skeleton in ascending order. Every data line must read
 * "source ; target ; MA". Each skeleton must be one ASCII letter, digit or dash that the file does not
 * map again, and the dash must stay a dash, because the code shape and the native table rely on both.
 */
export function deriveConfusableSubset(text) {
  const prototypes = new Map();
  text.split(/\r?\n/u).forEach((raw, index) => {
    const line = raw.replace(/#.*$/u, "").trim();
    if (line === "") return;
    const fields = line.split(";").map((field) => field.trim());
    const points = (field) => field.split(/\s+/u).map((digits) => (/^[0-9A-F]{4,6}$/u.test(digits) ? Number.parseInt(digits, 16) : Number.NaN));
    const [source, target] = fields.length === 3 && fields[2] === "MA" ? [points(fields[0]), points(fields[1])] : [[], []];
    if (source.length !== 1 || target.length === 0 || [...source, ...target].some(Number.isNaN)) {
      throw new Error(`confusables.txt line ${index + 1} is not "source ; target ; MA": ${raw}`);
    }
    if (prototypes.has(source[0])) throw new Error(`confusables.txt maps U+${hex(source[0]).slice(2)} more than once`);
    prototypes.set(source[0], String.fromCodePoint(...target));
  });
  const skeletons = {};
  for (const character of CODE_ALPHABET) {
    const skeleton = prototypes.get(character.codePointAt(0)) ?? character;
    if (!/^[0-9A-Za-z-]$/u.test(skeleton)) {
      throw new Error(`the skeleton of ${JSON.stringify(character)} is ${skeleton}, not one ASCII letter, digit or dash`);
    }
    if (skeleton !== character && prototypes.has(skeleton.codePointAt(0))) {
      throw new Error(`the skeleton ${skeleton} of ${JSON.stringify(character)} is itself mapped to ${prototypes.get(skeleton.codePointAt(0))}`);
    }
    skeletons[character] = skeleton;
  }
  if (skeletons["-"] !== "-") throw new Error(`the skeleton of "-" is ${skeletons["-"]}, not the dash the code shape needs`);
  const confusables = Object.fromEntries(skeletonOrder(skeletons).map((skeleton) => [skeleton, []]));
  for (const [point, prototype] of prototypes) if (Object.hasOwn(confusables, prototype)) confusables[prototype].push(point);
  for (const points of Object.values(confusables)) points.sort((left, right) => left - right);
  return { skeletons, confusables };
}

function wrapped(prefix, items, suffix, indent = "    ") {
  const lines = [];
  let line = prefix;
  items.forEach((item, index) => {
    const piece = index < items.length - 1 ? `${item},` : item;
    const candidate = index === 0 ? `${line}${piece}` : `${line} ${piece}`;
    if (candidate.length > 100 && index > 0) {
      lines.push(line);
      line = `${indent}${piece}`;
    } else line = candidate;
  });
  lines.push(`${line}${suffix}`);
  return lines.join("\n");
}

/** The committed subset module for `subset`, with the upstream file named in its header. */
export function renderConfusablesModule(subset, source = CONFUSABLES_SOURCE) {
  const skeletons = wrapped("  ", [...CODE_ALPHABET].map((character) =>
    `${JSON.stringify(character)}: ${JSON.stringify(subset.skeletons[character])}`), ",", "  ");
  const groups = skeletonOrder(subset.skeletons).map((skeleton) =>
    wrapped(`  ${JSON.stringify(skeleton)}: Object.freeze([`, subset.confusables[skeleton].map(hex), "]),"));
  return `// Generated by scripts/generate-device-label-table.mjs from Unicode confusables.txt (UTS #39),
// version ${source.unicode}:
//   ${source.url}
//   SHA-256 ${source.sha256}
// Unicode data files are provided under the Unicode License v3: https://www.unicode.org/license.txt
//
// A device label is compared as its UTS #39 skeleton, in which each code point becomes its confusable
// prototype. Only the part of the skeleton that can spell a comparison code matters, so this subset
// holds the skeleton of each comparison-code character [0-9A-Fa-f-] and every code point whose
// prototype is one of those skeletons, grouped by that skeleton.
// Do not edit: run
// \`node scripts/generate-device-label-table.mjs --write --confusables <path or URL of that file>\`.

export const DEVICE_LABEL_CONFUSABLES_SOURCE = Object.freeze({
  unicode: ${JSON.stringify(source.unicode)},
  url: ${JSON.stringify(source.url)},
  sha256: ${JSON.stringify(source.sha256)},
});

/** The skeleton of each comparison-code character: its confusable prototype, or itself. */
export const DEVICE_LABEL_CODE_SKELETONS = Object.freeze({
${skeletons}
});

/** Every code point whose confusable prototype is one of those skeletons, grouped by that skeleton. */
export const DEVICE_LABEL_CONFUSABLES = Object.freeze({
${groups.join("\n")}
});
`;
}

/** Problems with the committed subset module text, or an empty list when it is the generator's output. */
export function confusablesModuleDrift(checkedOutText, subset = COMMITTED_SUBSET, source = DEVICE_LABEL_CONFUSABLES_SOURCE) {
  const regenerate = `run node scripts/generate-device-label-table.mjs --write --confusables ${CONFUSABLES_SOURCE.url}`;
  const problems = [];
  if (source.unicode !== CONFUSABLES_SOURCE.unicode || source.url !== CONFUSABLES_SOURCE.url || source.sha256 !== CONFUSABLES_SOURCE.sha256) {
    problems.push(`${CONFUSABLES_PATH} names ${source.url} (SHA-256 ${source.sha256}), not the pinned ${CONFUSABLES_SOURCE.url} (SHA-256 ${CONFUSABLES_SOURCE.sha256}); ${regenerate}`);
  }
  if (checkedOutText.replace(/\r\n/gu, "\n") !== renderConfusablesModule(subset, source)) {
    problems.push(`${CONFUSABLES_PATH} differs from its generator output; ${regenerate}`);
  }
  return problems;
}

/**
 * The text of confusables.txt read from a path or downloaded from an https URL, refused unless its
 * SHA-256 is `sha256` (by default the pinned one).
 */
export async function readUpstreamConfusables(location, { fetch = globalThis.fetch, readFile = readFileSync, sha256 = CONFUSABLES_SOURCE.sha256 } = {}) {
  let bytes;
  if (/^https:\/\//u.test(location)) {
    const response = await fetch(location);
    if (!response.ok) throw new Error(`could not download ${location}: HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    bytes = readFile(location);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) {
    throw new Error(`confusables.txt from ${location}: its SHA-256 ${actual} is not the pinned ${sha256}; adopt another version only by changing CONFUSABLES_SOURCE`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function main() {
  const usage = "usage: node scripts/generate-device-label-table.mjs [--write [--confusables <path or https URL>]]";
  const argumentsGiven = process.argv.slice(2);
  let write = false;
  let confusables = null;
  for (let index = 0; index < argumentsGiven.length; index += 1) {
    if (argumentsGiven[index] === "--write" && !write) write = true;
    else if (argumentsGiven[index] === "--confusables" && confusables === null && index + 1 < argumentsGiven.length) confusables = argumentsGiven[++index];
    else throw new Error(usage);
  }
  if (confusables !== null && !write) throw new Error(usage);
  const tablePath = resolve(repositoryRoot, TABLE_PATH);
  const subsetPath = resolve(repositoryRoot, CONFUSABLES_PATH);
  if (write) {
    let subset = COMMITTED_SUBSET;
    let source = DEVICE_LABEL_CONFUSABLES_SOURCE;
    if (confusables !== null) {
      subset = deriveConfusableSubset(await readUpstreamConfusables(confusables));
      source = CONFUSABLES_SOURCE;
      writeFileSync(subsetPath, renderConfusablesModule(subset, source));
      console.log(`Wrote ${CONFUSABLES_PATH} from confusables.txt ${source.unicode} (SHA-256 ${source.sha256}).`);
    }
    writeFileSync(tablePath, renderDeviceLabelTable(process.versions.unicode, subset, source));
    console.log(`Wrote ${TABLE_PATH} with Unicode ${process.versions.unicode} data.`);
    return;
  }
  const problems = [...deviceLabelTableDrift(readFileSync(tablePath, "utf8")), ...confusablesModuleDrift(readFileSync(subsetPath, "utf8"))];
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
    return;
  }
  console.log(`Device-label table check passed: ${TABLE_PATH} matches the backend rule and ${CONFUSABLES_PATH}.`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
