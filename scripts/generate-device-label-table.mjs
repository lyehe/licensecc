// Renders src/library/device_identity/bound_label_table.hpp, the native client's copy of the
// device-label rule, from the licensing backend's rule in
// services/cloudflare-licensing-backend/src/device/device_label.mjs and its confusables subset in
// device_label_confusables.mjs. The backend owns the rule; this tool only expands its property
// escapes into code-point ranges and copies its skeleton fold and code skeletons, so the native
// client refuses the same labels before it sends one. It also derives that confusables subset from
// the pinned Unicode confusables.txt (UTS #39), when asked to.
//
//   node scripts/generate-device-label-table.mjs           check the committed table and subset
//   node scripts/generate-device-label-table.mjs --write   regenerate the table from the subset
//   node scripts/generate-device-label-table.mjs --write --confusables <path or https URL>
//       read or download confusables.txt, require its pinned SHA-256, derive the subset, require
//       the subset's pinned SHA-256, rewrite the committed subset, then regenerate the table
//
// The ranges come from the running engine's Unicode data. A table generated with newer data
// than the running engine still passes the check when every code point the two disagree on is
// unassigned in the running engine; a newer engine asks for the table to be regenerated. The
// confusables come only from the committed subset, so a check or a plain --write never reads the
// network, and they must match exactly whatever the engine. The committed subset must match its
// pinned SHA-256, so a hand edit is refused rather than copied into the table.
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
  DEVICE_LABEL_EXPANSIONS,
  DEVICE_LABEL_SEPARATOR_LOOKALIKES,
} from "../services/cloudflare-licensing-backend/src/device/device_label_confusables.mjs";

/** The committed subset, as the backend rule reads it. */
const COMMITTED_SUBSET = Object.freeze({
  skeletons: DEVICE_LABEL_CODE_SKELETONS,
  confusables: DEVICE_LABEL_CONFUSABLES,
  separators: DEVICE_LABEL_SEPARATOR_LOOKALIKES,
  expansions: DEVICE_LABEL_EXPANSIONS,
});

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const TABLE_PATH = "src/library/device_identity/bound_label_table.hpp";
export const DEVICE_LABEL_PATH = "services/cloudflare-licensing-backend/src/device/device_label.mjs";
export const CONFUSABLES_PATH = "services/cloudflare-licensing-backend/src/device/device_label_confusables.mjs";
const LAST_CODE_POINT = 0x10ffff;
const UNASSIGNED = /\p{Cn}/u;

/**
 * The upstream file the confusables subset is derived from, and the copyright of its data. Adopting
 * a new Unicode version means changing these values and CONFUSABLES_SUBSET_SHA256 together and
 * regenerating with --confusables, on an engine with the same Unicode version.
 */
export const CONFUSABLES_SOURCE = Object.freeze({
  unicode: "17.0.0",
  url: "https://www.unicode.org/Public/17.0.0/security/confusables.txt",
  sha256: "091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a",
  copyright: "1991-2025 Unicode, Inc.",
});

/**
 * The SHA-256 of the subset derived from that file, over confusablesSubsetCanonical. A check or a
 * write refuses a committed subset with any other digest, and a derivation must reproduce it.
 */
export const CONFUSABLES_SUBSET_SHA256 = "8ca9aec5f11b710ba03aecc28718ad1c7925a149a4fa6f0e327573bb9f449945";

/** The comparison-code alphabet [0-9A-Fa-f-], in the order JavaScript enumerates it as keys. */
const CODE_ALPHABET = "0123456789ABCDEFabcdef-";
/** What a listed code point may read as: code skeletons, "-" for a separator and "." for anything else. */
const EXPANSION = /^[0-9A-Za-z.-]{1,32}$/u;

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
const codePoint = (value) => `U+${hex(value).slice(2)}`;
const rows = (ranges) => ranges.map(([first, last]) => `\t{${hex(first)}, ${hex(last)}},`).join("\n");

/** The distinct skeletons of the code alphabet, in code-alphabet order. */
function skeletonOrder(skeletons) {
  return [...new Set([...CODE_ALPHABET].map((character) => skeletons[character]))];
}

/** The skeletons of the code digits and letters, without the dash, as one string. */
function codeSkeletons(skeletons) {
  return skeletonOrder(skeletons).filter((skeleton) => skeleton !== "-").join("");
}

/** [code point, what it reads as] for every listed code point, in code-point order. */
function foldPairs(subset) {
  return [
    ...Object.entries(subset.confusables).flatMap(([skeleton, points]) => points.map((point) => [point, skeleton])),
    ...subset.separators.map((point) => [point, "-"]),
    ...subset.expansions.map(([point, expansion]) => [point, expansion]),
  ].sort((left, right) => left[0] - right[0]);
}

/** Items joined by ", " and wrapped before column 100, each line after the first indented. */
function wrapped(prefix, items, suffix, indent = "    ", limit = 100) {
  const lines = [];
  let line = prefix;
  items.forEach((item, index) => {
    const piece = index < items.length - 1 ? `${item},` : item;
    const candidate = index === 0 ? `${line}${piece}` : `${line} ${piece}`;
    if (candidate.replace(/\t/gu, "    ").length > limit && index > 0) {
      lines.push(line);
      line = `${indent}${piece}`;
    } else line = candidate;
  });
  lines.push(`${line}${suffix}`);
  return lines.join("\n");
}

/** The table for the running engine's Unicode data, labelled with `unicode`. */
export function renderDeviceLabelTable(unicode = process.versions.unicode, subset = COMMITTED_SUBSET,
  source = DEVICE_LABEL_CONFUSABLES_SOURCE) {
  const folds = foldPairs(subset).map(([point, to]) => `{${hex(point)}, ${JSON.stringify(to)}}`);
  return `// Generated by scripts/generate-device-label-table.mjs from the device-label rule in
// services/cloudflare-licensing-backend/src/device/device_label.mjs, with Unicode ${unicode} data.
// Do not edit: run \`node scripts/generate-device-label-table.mjs --write\` and commit the result.
// The confusables fold is derived from Unicode confusables.txt ${source.unicode}:
// Copyright (C) ${source.copyright} Used under the Unicode License v3; the copyright and
// permission notice is in doc/other/CREDITS.md.
#pragma once
#include <cstdint>

namespace license {
namespace device_identity {
namespace bound_label_table {
struct Range {
	std::uint32_t first;
	std::uint32_t last;
};
// A code point and what it reads as in the comparison form.
struct Fold {
	std::uint32_t point;
	const char* to;
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
// What each listed code point reads as: its confusable prototype with each code skeleton kept, each
// separator read as '-' and any other character read as '.', which no code group holds. Unlisted
// code points read as themselves. Copied from device_label_confusables.mjs, by code point.
inline constexpr Fold confusables[] = {
${wrapped("\t", folds, "", "\t")}
};
// clang-format on
}  // namespace bound_label_table
}  // namespace device_identity
}  // namespace license
`;
}

/** The Unicode version, the two range lists, the code skeletons and the confusables fold of a rendered table. */
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
    confusables: folds === null ? null : [...folds.matchAll(/\{(0x[0-9A-F]+), "([^"]*)"\}/g)].map((match) => [Number(match[1]), match[2]]),
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

/**
 * Problems with the committed table text, or an empty list when it matches the rule. A subset that
 * fails its own checks is reported alone, because regenerating the table would only copy it.
 */
export function deviceLabelTableDrift(checkedOutText, unicode = process.versions.unicode, subset = COMMITTED_SUBSET) {
  const subsetProblems = confusablesSubsetProblems(subset);
  if (subsetProblems.length > 0) return subsetProblems;
  // A Windows checkout may carry CRLF line endings; the committed blob is LF.
  const committedText = checkedOutText.replace(/\r\n/gu, "\n");
  const regenerate = `run node scripts/generate-device-label-table.mjs --write with Unicode ${unicode} data and commit ${TABLE_PATH}`;
  const committed = parseDeviceLabelTable(committedText);
  if (committed.unicode === null || committed.refused === null || committed.separators === null || committed.skeletons === null
      || committed.confusables === null) {
    return [`${TABLE_PATH} is not a generated table; ${regenerate}`];
  }
  const expected = renderDeviceLabelTable(committed.unicode, subset);
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
 * The part of a confusables.txt text's UTS #39 skeleton that a comparison code can use. Every data
 * line must read "source ; target ; MA", and every character of every prototype must be a prototype
 * itself. A label's skeleton is read only as far as a comparison code goes: each code skeleton is
 * kept, each separator reads as "-", and any other character reads as ".", which no code group
 * holds. So the subset holds:
 *   skeletons    the prototype of each character of the code alphabet [0-9A-Fa-f-], or the
 *                character itself; each must be one ASCII letter, digit or dash not mapped again,
 *                and the dash must stay a dash;
 *   confusables  every code point whose prototype is one of those skeletons, grouped by it;
 *   separators   every code point, not itself a separator, whose skeleton is the skeleton of a
 *                separator (`isSeparator`, the dash and space rule) other than "-", which the
 *                confusables already hold;
 *   expansions   every code point whose prototype has several characters and holds a code
 *                skeleton or a separator, with what it reads as.
 * Every other code point reads as "." and is left out, because it breaks a code group exactly as
 * an unlisted character does.
 */
export function deriveConfusableSubset(text, { isSeparator = (point) => DEVICE_LABEL_SEPARATOR.test(String.fromCodePoint(point)) } = {}) {
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
    if (prototypes.has(source[0])) throw new Error(`confusables.txt maps ${codePoint(source[0])} more than once`);
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
  for (const [point, prototype] of prototypes) {
    for (const character of prototype) {
      const mapped = character.codePointAt(0);
      if (prototypes.has(mapped)) throw new Error(`the prototype of ${codePoint(point)} holds ${codePoint(mapped)}, which is itself mapped`);
    }
  }
  const skeletonOf = (point) => prototypes.get(point) ?? String.fromCodePoint(point);
  const separatorSkeletons = new Set();
  for (let point = 0; point <= LAST_CODE_POINT; point += 1) {
    if (point >= 0xd800 && point <= 0xdfff) continue;
    if (isSeparator(point)) separatorSkeletons.add(skeletonOf(point));
  }
  const code = new Set(codeSkeletons(skeletons));
  for (const skeleton of code) {
    if (separatorSkeletons.has(skeleton)) throw new Error(`the code skeleton ${skeleton} is also the skeleton of a separator`);
  }
  const confusables = Object.fromEntries(skeletonOrder(skeletons).map((skeleton) => [skeleton, []]));
  for (const [point, prototype] of prototypes) if (Object.hasOwn(confusables, prototype)) confusables[prototype].push(point);
  for (const points of Object.values(confusables)) points.sort((left, right) => left - right);
  const separators = [];
  for (let point = 0; point <= LAST_CODE_POINT; point += 1) {
    if ((point >= 0xd800 && point <= 0xdfff) || isSeparator(point)) continue;
    const skeleton = skeletonOf(point);
    if (skeleton !== "-" && separatorSkeletons.has(skeleton)) separators.push(point);
  }
  const listed = new Set(separators);
  const readAs = (character) => (code.has(character) ? character : separatorSkeletons.has(character) ? "-" : ".");
  const expansions = [];
  for (const [point, prototype] of prototypes) {
    const characters = [...prototype];
    if (characters.length < 2 || listed.has(point) || isSeparator(point)) continue;
    const expansion = characters.map(readAs).join("");
    if (/[^.]/u.test(expansion)) expansions.push([point, expansion]);
  }
  expansions.sort((left, right) => left[0] - right[0]);
  return { skeletons, confusables, separators, expansions };
}

/** The canonical serialization the subset digest is taken over. */
export function confusablesSubsetCanonical(subset) {
  return JSON.stringify({
    skeletons: [...CODE_ALPHABET].map((character) => [character, subset.skeletons[character]]),
    confusables: skeletonOrder(subset.skeletons).map((skeleton) => [skeleton, [...(subset.confusables[skeleton] ?? [])]]),
    separators: [...subset.separators],
    expansions: subset.expansions.map(([point, expansion]) => [point, expansion]),
  });
}

/** The SHA-256, in lowercase hex, of a subset's canonical serialization. */
export function confusablesSubsetSha256(subset) {
  return createHash("sha256").update(confusablesSubsetCanonical(subset)).digest("hex");
}

/**
 * Problems with a subset, or an empty list when it is well formed and matches the pinned digest.
 * Every list must be in ascending order, and no code point may be listed twice: the backend's map
 * keeps the last entry for a code point and the native binary search finds the first.
 */
export function confusablesSubsetProblems(subset) {
  const problems = [];
  const restore = `restore it with node scripts/generate-device-label-table.mjs --write --confusables ${CONFUSABLES_SOURCE.url}; a plain --write only copies the subset into the table`;
  const validPoint = (point) => Number.isSafeInteger(point) && point >= 0 && point <= LAST_CODE_POINT && (point < 0xd800 || point > 0xdfff);
  const ascending = (points, name) => {
    if (!points.every(validPoint)) problems.push(`${CONFUSABLES_PATH}: the ${name} hold a value that is not a Unicode scalar value`);
    else if (points.some((point, index) => index > 0 && point <= points[index - 1])) problems.push(`${CONFUSABLES_PATH}: the ${name} are not in ascending order`);
  };
  if (Object.keys(subset.skeletons).join("") !== CODE_ALPHABET || [...CODE_ALPHABET].some((character) => !/^[0-9A-Za-z-]$/u.test(subset.skeletons[character]))
      || subset.skeletons["-"] !== "-") {
    problems.push(`${CONFUSABLES_PATH}: the code skeletons are not one ASCII letter, digit or dash for each character of ${CODE_ALPHABET}`);
    return problems;
  }
  const order = skeletonOrder(subset.skeletons);
  if (JSON.stringify(Object.keys(subset.confusables).sort()) !== JSON.stringify([...order].sort())) {
    problems.push(`${CONFUSABLES_PATH}: the confusables are not grouped by exactly the code skeletons`);
  }
  for (const skeleton of order) ascending(subset.confusables[skeleton] ?? [], `code points that fold to ${skeleton}`);
  ascending(subset.separators, "separator look-alikes");
  ascending(subset.expansions.map(([point]) => point), "expansions");
  for (const [point, expansion] of subset.expansions) {
    const kept = [...String(expansion)].every((character) => character === "." || character === "-" || order.includes(character));
    if (typeof expansion !== "string" || !EXPANSION.test(expansion) || !kept || !/[^.]/u.test(expansion)) {
      problems.push(`${CONFUSABLES_PATH}: the expansion of ${codePoint(point)} ${JSON.stringify(expansion)} is not made of code skeletons, "-" and "."`);
    }
  }
  const seen = new Set();
  for (const [point] of foldPairs(subset)) {
    if (seen.has(point)) problems.push(`${CONFUSABLES_PATH}: ${codePoint(point)} is listed more than once`);
    seen.add(point);
  }
  const digest = confusablesSubsetSha256(subset);
  if (digest !== CONFUSABLES_SUBSET_SHA256) {
    problems.push(`${CONFUSABLES_PATH}: its subset SHA-256 ${digest} is not the pinned ${CONFUSABLES_SUBSET_SHA256}; ${restore}`);
  }
  return problems;
}

/** The committed subset module for `subset`, with the upstream file named in its header. */
export function renderConfusablesModule(subset, source = CONFUSABLES_SOURCE) {
  const skeletons = wrapped("  ", [...CODE_ALPHABET].map((character) =>
    `${JSON.stringify(character)}: ${JSON.stringify(subset.skeletons[character])}`), ",", "  ");
  const groups = skeletonOrder(subset.skeletons).map((skeleton) =>
    wrapped(`  ${JSON.stringify(skeleton)}: Object.freeze([`, subset.confusables[skeleton].map(hex), "]),"));
  const separators = wrapped("export const DEVICE_LABEL_SEPARATOR_LOOKALIKES = Object.freeze([", subset.separators.map(hex), "]);");
  const expansions = wrapped("  ", subset.expansions.map(([point, expansion]) => `[${hex(point)}, ${JSON.stringify(expansion)}]`), "", "  ");
  return `// Generated by scripts/generate-device-label-table.mjs from Unicode confusables.txt (UTS #39),
// version ${source.unicode}:
//   ${source.url}
//   SHA-256 ${source.sha256}
// Copyright © ${source.copyright} Unicode data files are provided under the Unicode
// License v3; the copyright and permission notice is in doc/other/CREDITS.md.
//
// A device label is compared as its UTS #39 skeleton, in which each code point becomes its
// confusable prototype, read only as far as a comparison code goes: each code skeleton is kept, each
// separator reads as "-", and any other character reads as ".", which no code group holds. This
// subset holds what that needs: the skeleton of each comparison-code character [0-9A-Fa-f-], the
// code points whose prototype is one of those skeletons, the code points that share a separator's
// skeleton, and the code points whose prototype of several characters holds a code skeleton or a
// separator. Every other code point reads as "." and is left out.
// Do not edit: run
// \`node scripts/generate-device-label-table.mjs --write --confusables <path or URL of that file>\`.

export const DEVICE_LABEL_CONFUSABLES_SOURCE = Object.freeze({
  unicode: ${JSON.stringify(source.unicode)},
  url: ${JSON.stringify(source.url)},
  sha256: ${JSON.stringify(source.sha256)},
  copyright: ${JSON.stringify(source.copyright)},
});

/** The skeleton of each comparison-code character: its confusable prototype, or itself. */
export const DEVICE_LABEL_CODE_SKELETONS = Object.freeze({
${skeletons}
});

/** Every code point whose confusable prototype is one of those skeletons, grouped by that skeleton. */
export const DEVICE_LABEL_CONFUSABLES = Object.freeze({
${groups.join("\n")}
});

/** Every code point, not itself a dash or space, whose skeleton is the skeleton of one; each reads as "-". */
${separators}

/** Every code point whose prototype of several characters holds a code skeleton or a separator, with
 *  what it reads as. */
export const DEVICE_LABEL_EXPANSIONS = Object.freeze([
${expansions}
].map((pair) => Object.freeze(pair)));
`;
}

/** Problems with the committed subset module text, or an empty list when it renders exactly its own data. */
export function confusablesModuleDrift(checkedOutText, subset = COMMITTED_SUBSET, source = DEVICE_LABEL_CONFUSABLES_SOURCE) {
  const regenerate = `run node scripts/generate-device-label-table.mjs --write --confusables ${CONFUSABLES_SOURCE.url}`;
  const problems = [];
  if (JSON.stringify({ ...source }) !== JSON.stringify({ ...CONFUSABLES_SOURCE })) {
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

function fail(problems) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
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
      // The separator look-alikes depend on the engine's dash and space data, so derive only with the
      // Unicode version the file was made for.
      if (!CONFUSABLES_SOURCE.unicode.startsWith(`${process.versions.unicode}.`)) {
        throw new Error(`deriving from confusables.txt ${CONFUSABLES_SOURCE.unicode} needs an engine with that Unicode version; this one has Unicode ${process.versions.unicode}`);
      }
      subset = deriveConfusableSubset(await readUpstreamConfusables(confusables));
      source = CONFUSABLES_SOURCE;
      const digest = confusablesSubsetSha256(subset);
      if (digest !== CONFUSABLES_SUBSET_SHA256) {
        throw new Error(`the subset derived from confusables.txt ${source.unicode} has SHA-256 ${digest}, not the pinned ${CONFUSABLES_SUBSET_SHA256}; review the difference and change CONFUSABLES_SUBSET_SHA256 with it`);
      }
      writeFileSync(subsetPath, renderConfusablesModule(subset, source));
      console.log(`Wrote ${CONFUSABLES_PATH} from confusables.txt ${source.unicode} (SHA-256 ${source.sha256}).`);
    } else {
      const problems = confusablesSubsetProblems(subset);
      if (problems.length > 0) return fail(problems);
    }
    writeFileSync(tablePath, renderDeviceLabelTable(process.versions.unicode, subset, source));
    console.log(`Wrote ${TABLE_PATH} with Unicode ${process.versions.unicode} data.`);
    return;
  }
  const problems = [...deviceLabelTableDrift(readFileSync(tablePath, "utf8")), ...confusablesModuleDrift(readFileSync(subsetPath, "utf8"))];
  if (problems.length > 0) return fail(problems);
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
