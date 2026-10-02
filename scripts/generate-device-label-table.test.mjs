import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  CONFUSABLES_PATH,
  CONFUSABLES_SOURCE,
  CONFUSABLES_SUBSET_SHA256,
  confusablesModuleDrift,
  confusablesSubsetProblems,
  confusablesSubsetSha256,
  deriveConfusableSubset,
  DEVICE_LABEL_PATH,
  deviceLabelTableDrift,
  parseDeviceLabelTable,
  readUpstreamConfusables,
  renderConfusablesModule,
  renderDeviceLabelTable,
  TABLE_PATH,
  unexplainedDifference,
} from "./generate-device-label-table.mjs";
import {
  DEVICE_LABEL_CODE_SKELETONS,
  DEVICE_LABEL_CONFUSABLES,
  DEVICE_LABEL_CONFUSABLES_SOURCE,
  DEVICE_LABEL_EXPANSIONS,
  DEVICE_LABEL_SEPARATOR_LOOKALIKES,
} from "../services/cloudflare-licensing-backend/src/device/device_label_confusables.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const committed = readFileSync(resolve(repositoryRoot, TABLE_PATH), "utf8");
const committedConfusables = readFileSync(resolve(repositoryRoot, CONFUSABLES_PATH), "utf8");
const COMMITTED_SUBSET = {
  skeletons: DEVICE_LABEL_CODE_SKELETONS,
  confusables: DEVICE_LABEL_CONFUSABLES,
  separators: DEVICE_LABEL_SEPARATOR_LOOKALIKES,
  expansions: DEVICE_LABEL_EXPANSIONS,
};
// A copy of the committed subset that a test may change.
const subsetCopy = () => ({
  skeletons: { ...DEVICE_LABEL_CODE_SKELETONS },
  confusables: Object.fromEntries(Object.entries(DEVICE_LABEL_CONFUSABLES).map(([skeleton, points]) => [skeleton, [...points]])),
  separators: [...DEVICE_LABEL_SEPARATOR_LOOKALIKES],
  expansions: DEVICE_LABEL_EXPANSIONS.map(([point, expansion]) => [point, expansion]),
});
// The order the subset keeps: JavaScript enumerates the digit keys first.
const CODE_ALPHABET = [..."0123456789ABCDEFabcdef-"];
// The UTS #39 skeleton of each code character: 0 reads as O and 1 as l; the rest are their own.
const CODE_SKELETONS = Object.fromEntries(CODE_ALPHABET.map((character) => [character, { 0: "O", 1: "l" }[character] ?? character]));

test("the committed native device-label table matches the backend rule", () => {
  assert.deepEqual(deviceLabelTableDrift(committed), []);
});

test("the table holds the code points the backend refuses and maps to separators", () => {
  const table = parseDeviceLabelTable(committed);
  const holds = (ranges, point) => ranges.some(([first, last]) => point >= first && point <= last);
  // Controls, format characters, separators and default-ignorable code points.
  for (const point of [0x00, 0x1f, 0x7f, 0x85, 0x9f, 0xad, 0x34f, 0x61c, 0x200b, 0x200e, 0x2028, 0x2029, 0x202e, 0x2060, 0x206a, 0x2066,
    0x2069, 0x3164, 0xfe0f, 0xfeff, 0xfff9, 0xe0041]) {
    assert.ok(holds(table.refused, point), `refused U+${point.toString(16)}`);
  }
  for (const point of [0x20, 0x41, 0x2d, 0xe9, 0x5de5]) assert.ok(!holds(table.refused, point), `allowed U+${point.toString(16)}`);
  // Dashes and spaces.
  for (const point of [0x20, 0x2d, 0xa0, 0x2010, 0x2013, 0x2014, 0x3000, 0xfe63, 0xff0d]) {
    assert.ok(holds(table.separators, point), `separator U+${point.toString(16)}`);
  }
  for (const point of [0x5f, 0x2e, 0x41]) assert.ok(!holds(table.separators, point), `not a separator U+${point.toString(16)}`);
});

// The table as checked out, and as a Windows checkout with core.autocrlf would carry it.
const CHECKOUTS = [
  ["as checked out", committed],
  ["with CRLF line endings", committed.replace(/\r\n/gu, "\n").replace(/\n/gu, "\r\n")],
];

// Edits one checkout's text on its LF form, keeps the checkout's line endings, and fails if the
// edit matched nothing.
function edit(checkout, from, to) {
  const lf = checkout.replace(/\r\n/gu, "\n");
  const edited = lf.replace(from, to);
  assert.notEqual(edited, lf, `the edit ${String(from)} must change the table`);
  return checkout.includes("\r\n") ? edited.replace(/\n/gu, "\r\n") : edited;
}

for (const [label, checkout] of CHECKOUTS) {
  test(`a hand edit or a stale table is reported, with the command that regenerates it (${label})`, () => {
    const problems = deviceLabelTableDrift(edit(checkout, "\t{0x00AD, 0x00AD},\n", ""));
    // Same Unicode data: an exact mismatch. Older data in this engine: the assigned soft hyphen.
    assert.equal(problems.length, 1);
    assert.match(problems[0], /(?:differs from the backend rule|assigned code points 0x00AD); run node scripts\/generate-device-label-table\.mjs --write/u);
    assert.match(deviceLabelTableDrift("// not generated")[0], /is not a generated table/u);
  });

  test(`a table generated with other Unicode data passes only where this engine has not assigned the difference (${label})`, () => {
    // The same ranges labelled with another version take the tolerant path and pass.
    const relabelled = edit(checkout, /with Unicode \S+ data\./u, "with Unicode 0.0 data.");
    assert.deepEqual(deviceLabelTableDrift(relabelled), []);
    // A difference on an assigned code point fails, as a newer engine's new assignments would.
    const missingSoftHyphen = edit(relabelled, "\t{0x00AD, 0x00AD},\n", "");
    assert.match(deviceLabelTableDrift(missingSoftHyphen).join("\n"), /refused differs from this engine's Unicode \S+ data on assigned code points 0x00AD/u);
  });
}

test("a code point difference the engine has not assigned is what an older engine sees in a newer table", () => {
  assert.deepEqual(unexplainedDifference([[0x10, 0x12]], [[0x10, 0x11]], (point) => point === 0x12), []);
  assert.deepEqual(unexplainedDifference([[0x10, 0x12]], [[0x11, 0x13]], () => false), [0x10, 0x13]);
});

test("a checkout with CRLF line endings still matches", () => {
  const lf = committed.replace(/\r\n/gu, "\n");
  assert.deepEqual(deviceLabelTableDrift(lf.replace(/\n/gu, "\r\n")), []);
});

test("the generator is deterministic for one engine", () => {
  assert.equal(renderDeviceLabelTable("1.0"), renderDeviceLabelTable("1.0"));
});

test("the table folds every look-alike of a comparison-code character to that character's skeleton", () => {
  const table = parseDeviceLabelTable(committed);
  const folds = new Map(table.confusables);
  // Cyrillic A, Greek Alpha, Cyrillic small a, mathematical bold four, the minus sign, and the
  // stand-ins for 0 and 1: Cyrillic O to O, Cyrillic I to l.
  for (const [point, to] of [[0x410, "A"], [0x391, "A"], [0x430, "a"], [0x1d7d2, "4"], [0x2212, "-"], [0x41e, "O"], [0x406, "l"]]) {
    assert.equal(folds.get(point), to, `U+${point.toString(16)} folds to ${to}`);
  }
  // Prototypes of several characters: Roman numeral two, double vertical line, Latin double O,
  // Cyrillic yu, the ff ligature, the AE ligature, and a digit four full stop whose stop is no code
  // character and so breaks a group.
  for (const [point, to] of [[0x2161, "ll"], [0x2016, "ll"], [0xa74e, "OO"], [0x42e, "lO"], [0xfb00, "ff"], [0xc6, "AE"], [0x248b, "4."]]) {
    assert.equal(folds.get(point), to, `U+${point.toString(16)} expands to ${to}`);
  }
  // Characters that share a separator's skeleton: CJK one, box-drawing horizontals, the prolonged
  // sound mark and the Hangul letter eu.
  for (const point of [0x4e00, 0x2500, 0x2501, 0x30fc, 0x3161, 0x2f00]) assert.equal(folds.get(point), "-", `U+${point.toString(16)} separates`);
  // In ASCII 0 folds to O; 1, I and | fold to l; = shares the skeleton of a double hyphen.
  assert.deepEqual([...folds].filter(([point]) => point < 0x80), [[0x30, "O"], [0x31, "l"], [0x3d, "-"], [0x49, "l"], [0x7c, "l"]]);
  // Every fold is made of code skeletons, dashes and the "." that breaks a group, and keeps at least
  // one code skeleton or dash.
  assert.ok([...folds.values()].every((to) => /^[Ol2-9A-Fa-f.-]+$/u.test(to) && /[^.]/u.test(to)));
  // The code shape is made of the skeletons of the code digits and letters.
  assert.equal(table.skeletons, "Ol23456789ABCDEFabcdef");
});

test("the table folds exactly the committed confusables subset, in code-point order", () => {
  const expected = [
    ...Object.entries(DEVICE_LABEL_CONFUSABLES).flatMap(([to, points]) => points.map((point) => [point, to])),
    ...DEVICE_LABEL_SEPARATOR_LOOKALIKES.map((point) => [point, "-"]),
    ...DEVICE_LABEL_EXPANSIONS.map(([point, to]) => [point, to]),
  ].sort((left, right) => left[0] - right[0]);
  assert.ok(expected.length > 900);
  assert.deepEqual(parseDeviceLabelTable(committed).confusables, expected);
});

test("the committed subset module names the pinned upstream file and renders exactly its own data", () => {
  assert.deepEqual({ ...DEVICE_LABEL_CONFUSABLES_SOURCE }, { ...CONFUSABLES_SOURCE });
  assert.match(CONFUSABLES_SOURCE.url, /^https:\/\/www\.unicode\.org\/Public\/[0-9.]+\/security\/confusables\.txt$/u);
  assert.match(CONFUSABLES_SOURCE.sha256, /^[0-9a-f]{64}$/u);
  const header = committedConfusables.slice(0, committedConfusables.indexOf("export"));
  for (const value of [CONFUSABLES_SOURCE.unicode, CONFUSABLES_SOURCE.url, CONFUSABLES_SOURCE.sha256, "Copyright © 1991-2025 Unicode, Inc.", "doc/other/CREDITS.md"]) {
    assert.ok(header.includes(value), `the header names ${value}`);
  }
  assert.deepEqual({ ...DEVICE_LABEL_CODE_SKELETONS }, CODE_SKELETONS);
  assert.deepEqual(new Set(Object.keys(DEVICE_LABEL_CONFUSABLES)), new Set(Object.values(CODE_SKELETONS)));
  assert.deepEqual(confusablesModuleDrift(committedConfusables), []);
  assert.deepEqual(confusablesModuleDrift(committedConfusables.replace(/\r\n/gu, "\n").replace(/\n/gu, "\r\n")), []);
});

test("the derived Unicode data carries its copyright and points to the full permission notice", () => {
  // The native table stays ASCII, so it spells the copyright sign as (C).
  for (const value of ["Copyright (C) 1991-2025 Unicode, Inc.", "Unicode License v3", "doc/other/CREDITS.md"]) {
    assert.ok(committed.includes(value), `the native table names ${value}`);
  }
  const credits = readFileSync(resolve(repositoryRoot, "doc/other/CREDITS.md"), "utf8");
  for (const value of ["UNICODE LICENSE V3", "COPYRIGHT AND PERMISSION NOTICE", "Copyright © 1991-2025 Unicode, Inc.",
    "this copyright and permission notice appear with all copies of the Data", CONFUSABLES_SOURCE.url]) {
    assert.ok(credits.includes(value), `the credits hold ${value}`);
  }
});

test("the committed subset matches its pinned SHA-256 and is sorted, unique and disjoint", () => {
  assert.match(CONFUSABLES_SUBSET_SHA256, /^[0-9a-f]{64}$/u);
  assert.equal(confusablesSubsetSha256(COMMITTED_SUBSET), CONFUSABLES_SUBSET_SHA256);
  assert.deepEqual(confusablesSubsetProblems(COMMITTED_SUBSET), []);
  // A changed code point keeps every list sorted and disjoint, so only the pinned digest notices it.
  const changed = subsetCopy();
  changed.confusables.A[changed.confusables.A.indexOf(0x410)] = 0x411;
  assert.match(confusablesSubsetProblems(changed).join("\n"), /SHA-256 [0-9a-f]{64} is not the pinned/u);
  // A code point in two groups would fold differently on each side: the backend's map keeps the last
  // entry and the native binary search finds the first.
  const twice = subsetCopy();
  twice.confusables.B = [...twice.confusables.B, 0x410].sort((left, right) => left - right);
  assert.match(confusablesSubsetProblems(twice).join("\n"), /U\+0410 is listed more than once/u);
  const unsorted = subsetCopy();
  unsorted.separators.reverse();
  assert.match(confusablesSubsetProblems(unsorted).join("\n"), /separator look-alikes are not in ascending order/u);
  const malformed = subsetCopy();
  malformed.expansions[0] = [malformed.expansions[0][0], "A?"];
  assert.match(confusablesSubsetProblems(malformed).join("\n"), /expansion of U\+[0-9A-F]{4,6} /u);
});

// What the command line sees: the generator, the rule and the subset copied into a scratch tree,
// with the subset module edited by hand.
test("the check and a plain --write both refuse a hand-edited subset module", () => {
  const root = mkdtempSync(join(tmpdir(), "device-label-table-"));
  try {
    for (const path of ["scripts/generate-device-label-table.mjs", DEVICE_LABEL_PATH, CONFUSABLES_PATH, TABLE_PATH]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(resolve(repositoryRoot, path), join(root, path));
    }
    const run = (...args) => spawnSync(process.execPath, [join(root, "scripts/generate-device-label-table.mjs"), ...args], { encoding: "utf8" });
    assert.equal(run().status, 0, "the untouched copy passes");
    writeFileSync(join(root, CONFUSABLES_PATH), committedConfusables.replace("0x0410", "0x0411"));
    const check = run();
    assert.equal(check.status, 1);
    assert.match(check.stderr, /SHA-256 [0-9a-f]{64} is not the pinned/u);
    assert.match(check.stderr, /--write --confusables https:\/\/www\.unicode\.org\//u);
    assert.doesNotMatch(check.stderr, /run node scripts\/generate-device-label-table\.mjs --write with/u);
    const write = run("--write");
    assert.notEqual(write.status, 0);
    assert.match(write.stderr, /SHA-256 [0-9a-f]{64} is not the pinned/u);
    assert.equal(readFileSync(join(root, TABLE_PATH), "utf8"), committed, "a plain --write leaves the table as it was");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [label, checkout] of CHECKOUTS) {
  test(`a hand edit of a confusables row is reported, with the command that regenerates it (${label})`, () => {
    const altered = edit(checkout, '{0x0410, "A"}', '{0x0410, "B"}');
    assert.match(deviceLabelTableDrift(altered).join("\n"), /differs from the backend rule|confusables differ/u);
    // Another engine's Unicode data never excuses a confusables difference: that data is pinned.
    const relabelled = edit(altered, /with Unicode \S+ data/u, "with Unicode 0.0 data");
    assert.match(deviceLabelTableDrift(relabelled).join("\n"), /confusables differ from .*device_label_confusables\.mjs/u);
  });
}

// A synthetic confusables.txt: every line form the upstream file uses, without the network.
const SAMPLE_CONFUSABLES = [
  "# confusables.txt",
  "# Version: 0.0.0",
  "",
  "0410 ;\t0041 ;\tMA\t# ( А → A ) CYRILLIC CAPITAL LETTER A → LATIN CAPITAL LETTER A\t# ",
  "0391 ;\t0041 ;\tMA\t# ( Α → A ) GREEK CAPITAL LETTER ALPHA → LATIN CAPITAL LETTER A\t# ",
  "1D7D2 ;\t0034 ;\tMA\t# ( 𝟒 → 4 ) MATHEMATICAL BOLD DIGIT FOUR → DIGIT FOUR\t# ",
  "2212 ;\t002D ;\tMA\t# ( − → - ) MINUS SIGN → HYPHEN-MINUS\t# ",
  "0430 ;\t0061 ;\tMA\t# ( а → a ) CYRILLIC SMALL LETTER A → LATIN SMALL LETTER A\t# ",
  "0030 ;\t004F ;\tMA\t# ( 0 → O ) DIGIT ZERO → LATIN CAPITAL LETTER O\t# ",
  "041E ;\t004F ;\tMA\t# ( О → O ) CYRILLIC CAPITAL LETTER O → LATIN CAPITAL LETTER O\t# ",
  "0031 ;\t006C ;\tMA\t# ( 1 → l ) DIGIT ONE → LATIN SMALL LETTER L\t# ",
  "0049 ;\t006C ;\tMA\t# ( I → l ) LATIN CAPITAL LETTER I → LATIN SMALL LETTER L\t# ",
  "03BF ;\t006F ;\tMA\t# ( ο → o ) GREEK SMALL LETTER OMICRON → LATIN SMALL LETTER O\t# ",
  "00C6 ;\t0041 0045 ;\tMA\t# ( Æ → AE ) LATIN CAPITAL LETTER AE → LATIN CAPITAL LETTER A, LATIN CAPITAL LETTER E\t# ",
  "248B ;\t0034 002E ;\tMA\t# ( ⒋ → 4. ) DIGIT FOUR FULL STOP → DIGIT FOUR, FULL STOP\t# ",
  "2A2A ;\t002D 0323 ;\tMA\t# ( ⨪ → -̣ ) MINUS SIGN WITH DOT BELOW → HYPHEN-MINUS, COMBINING DOT BELOW\t# ",
  "FB06 ;\t0073 0074 ;\tMA\t# ( ﬆ → st ) LATIN SMALL LIGATURE ST → LATIN SMALL LETTER S, LATIN SMALL LETTER T\t# ",
  "2014 ;\t30FC ;\tMA\t# ( — → ー ) EM DASH → KATAKANA-HIRAGANA PROLONGED SOUND MARK\t# ",
  "2500 ;\t30FC ;\tMA\t# ( ─ → ー ) BOX DRAWINGS LIGHT HORIZONTAL → KATAKANA-HIRAGANA PROLONGED SOUND MARK\t# ",
  "0261 ;\t0067 ;\tMA\t# ( ɡ → g ) LATIN SMALL LETTER SCRIPT G → LATIN SMALL LETTER G\t# ",
  "",
].join("\n");

test("deriving the subset keeps each code point whose prototype can spell or separate a code", () => {
  const subset = deriveConfusableSubset(SAMPLE_CONFUSABLES);
  assert.deepEqual(subset.skeletons, CODE_SKELETONS);
  const nonEmpty = Object.fromEntries(Object.entries(subset.confusables).filter(([, points]) => points.length > 0));
  // A small o is the skeleton of no code character, so Greek omicron stays out.
  assert.deepEqual(nonEmpty, { "-": [0x2212], 4: [0x1d7d2], A: [0x391, 0x410], a: [0x430], O: [0x30, 0x41e], l: [0x31, 0x49] });
  // The em dash is a separator, so the box-drawing horizontal and the prolonged sound mark, which
  // share its skeleton, separate too.
  assert.deepEqual(subset.separators, [0x2500, 0x30fc]);
  // A prototype of several characters keeps its code skeletons, reads each separator as "-" and
  // each other character as "."; one with no code skeleton and no separator (ﬆ, "st") is left out,
  // because it breaks a group exactly as an unlisted character does.
  assert.deepEqual(subset.expansions, [[0xc6, "AE"], [0x248b, "4."], [0x2a2a, "-."]]);
  assert.throws(() => deriveConfusableSubset("0410 ; 0041\n"), /confusables\.txt line 1/u);
  assert.throws(() => deriveConfusableSubset("0410 ;\t0041 ;\tMA\n0410 ;\t0042 ;\tMA\n"), /U\+0410 .*more than once/u);
  // A code character must fold to one ASCII letter, digit or dash that is not itself mapped again.
  assert.throws(() => deriveConfusableSubset("0030 ;\t004F 004F ;\tMA\n"), /skeleton of "0" .*one ASCII/u);
  assert.throws(() => deriveConfusableSubset("0030 ;\t004F ;\tMA\n004F ;\t0051 ;\tMA\n"), /skeleton O of "0" is itself mapped/u);
  // Every prototype character must be a prototype itself, or the expansion would not be a skeleton.
  assert.throws(() => deriveConfusableSubset("00C6 ;\t0041 0058 ;\tMA\n0058 ;\t0059 ;\tMA\n"), /prototype of U\+00C6 holds U\+0058, which is itself mapped/u);
  const rendered = renderConfusablesModule(subset, CONFUSABLES_SOURCE);
  assert.match(rendered, /"0": "O", "1": "l", "2": "2"/u);
  assert.match(rendered, /"A": Object\.freeze\(\[0x0391, 0x0410\]\)/u);
  assert.match(rendered, /"O": Object\.freeze\(\[0x0030, 0x041E\]\)/u);
  assert.match(rendered, /\[0x00C6, "AE"\], \[0x248B, "4\."\], \[0x2A2A, "-\."\]/u);
});

test("the upstream file is accepted only with the pinned SHA-256, from a path or a URL", async () => {
  const bytes = new TextEncoder().encode(SAMPLE_CONFUSABLES);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const readFile = (path) => {
    assert.equal(path, "upstream/confusables.txt");
    return bytes;
  };
  assert.equal(await readUpstreamConfusables("upstream/confusables.txt", { readFile, sha256 }), SAMPLE_CONFUSABLES);
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(url);
    return new Response(bytes);
  };
  assert.equal(await readUpstreamConfusables("https://example.test/confusables.txt", { fetch, sha256 }), SAMPLE_CONFUSABLES);
  assert.deepEqual(fetched, ["https://example.test/confusables.txt"]);
  await assert.rejects(readUpstreamConfusables("upstream/confusables.txt", { readFile, sha256: "0".repeat(64) }),
    new RegExp(`SHA-256 ${sha256} is not the pinned 0{64}`, "u"));
  await assert.rejects(readUpstreamConfusables("https://example.test/missing", { fetch: async () => new Response("", { status: 404 }), sha256 }),
    /HTTP 404/u);
});
