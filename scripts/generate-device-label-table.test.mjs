import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  deviceLabelTableDrift,
  parseDeviceLabelTable,
  renderDeviceLabelTable,
  TABLE_PATH,
  unexplainedDifference,
} from "./generate-device-label-table.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const committed = readFileSync(resolve(repositoryRoot, TABLE_PATH), "utf8");

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
