import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  CONFUSABLES_PATH,
  CONFUSABLES_SOURCE,
  confusablesModuleDrift,
  deriveConfusableSubset,
  deviceLabelTableDrift,
  parseDeviceLabelTable,
  readUpstreamConfusables,
  renderConfusablesModule,
  renderDeviceLabelTable,
  TABLE_PATH,
  unexplainedDifference,
} from "./generate-device-label-table.mjs";
import {
  DEVICE_LABEL_CONFUSABLES,
  DEVICE_LABEL_CONFUSABLES_SOURCE,
} from "../services/cloudflare-licensing-backend/src/device/device_label_confusables.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const committed = readFileSync(resolve(repositoryRoot, TABLE_PATH), "utf8");
const committedConfusables = readFileSync(resolve(repositoryRoot, CONFUSABLES_PATH), "utf8");
// The order the subset keeps: JavaScript enumerates the digit keys first.
const CODE_ALPHABET = [..."0123456789ABCDEFabcdef-"];

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

test("the table folds look-alikes of the comparison-code alphabet from other scripts", () => {
  const folds = new Map(parseDeviceLabelTable(committed).confusables);
  // Cyrillic A, Greek Alpha, Cyrillic small a, mathematical bold four and the minus sign.
  for (const [point, to] of [[0x410, "A"], [0x391, "A"], [0x430, "a"], [0x1d7d2, "4"], [0x2212, "-"]]) {
    assert.equal(folds.get(point), to, `U+${point.toString(16)} folds to ${to}`);
  }
  // ASCII is never folded, and nothing folds outside the code alphabet.
  assert.ok([...folds.keys()].every((point) => point > 0x7f));
  assert.ok([...folds.values()].every((to) => CODE_ALPHABET.includes(to)));
});

test("the table folds exactly the committed confusables subset, in code-point order", () => {
  const expected = Object.entries(DEVICE_LABEL_CONFUSABLES)
    .flatMap(([to, points]) => points.map((point) => [point, to]))
    .sort((left, right) => left[0] - right[0]);
  assert.ok(expected.length > 300);
  assert.deepEqual(parseDeviceLabelTable(committed).confusables, expected);
});

test("the committed confusables subset names the pinned upstream file and is the generator's output", () => {
  assert.deepEqual({ ...DEVICE_LABEL_CONFUSABLES_SOURCE }, { ...CONFUSABLES_SOURCE });
  assert.match(CONFUSABLES_SOURCE.url, /^https:\/\/www\.unicode\.org\/Public\/[0-9.]+\/security\/confusables\.txt$/u);
  assert.match(CONFUSABLES_SOURCE.sha256, /^[0-9a-f]{64}$/u);
  for (const header of [CONFUSABLES_SOURCE.unicode, CONFUSABLES_SOURCE.url, CONFUSABLES_SOURCE.sha256]) {
    assert.ok(committedConfusables.slice(0, committedConfusables.indexOf("export")).includes(header), `the header names ${header}`);
  }
  assert.deepEqual(Object.keys(DEVICE_LABEL_CONFUSABLES), CODE_ALPHABET);
  assert.deepEqual(confusablesModuleDrift(committedConfusables), []);
  assert.deepEqual(confusablesModuleDrift(committedConfusables.replace(/\r\n/gu, "\n").replace(/\n/gu, "\r\n")), []);
  assert.match(confusablesModuleDrift(committedConfusables.replace("0x0410", "0x0411")).join("\n"),
    /device_label_confusables\.mjs differs from its generator output; run node scripts\/generate-device-label-table\.mjs --write --confusables/u);
});

for (const [label, checkout] of CHECKOUTS) {
  test(`a hand edit of a confusables row is reported, with the command that regenerates it (${label})`, () => {
    const altered = edit(checkout, "{0x0410, 'A'}", "{0x0410, 'B'}");
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
  "00C6 ;\t0041 0045 ;\tMA\t# ( Æ → AE ) LATIN CAPITAL LETTER AE → LATIN CAPITAL LETTER A, LATIN CAPITAL LETTER E\t# ",
  "0261 ;\t0067 ;\tMA\t# ( ɡ → g ) LATIN SMALL LETTER SCRIPT G → LATIN SMALL LETTER G\t# ",
  "",
].join("\n");

test("deriving the subset keeps each code point whose prototype is one code-alphabet character", () => {
  const subset = deriveConfusableSubset(SAMPLE_CONFUSABLES);
  assert.deepEqual(Object.keys(subset), CODE_ALPHABET);
  const nonEmpty = Object.fromEntries(Object.entries(subset).filter(([, points]) => points.length > 0));
  assert.deepEqual(nonEmpty, { "-": [0x2212], 4: [0x1d7d2], A: [0x391, 0x410], a: [0x430] });
  assert.throws(() => deriveConfusableSubset("0410 ; 0041\n"), /confusables\.txt line 1/u);
  assert.throws(() => deriveConfusableSubset("0410 ;\t0041 ;\tMA\n0410 ;\t0042 ;\tMA\n"), /U\+0410 .*more than once/u);
  assert.match(renderConfusablesModule(subset, CONFUSABLES_SOURCE), /"A": Object\.freeze\(\[0x0391, 0x0410\]\)/u);
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
