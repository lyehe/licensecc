import test from "node:test";
import assert from "node:assert/strict";
import { constantTimeEqual, readTextBody, safeString } from "@licensecc/cloudflare-runtime/http/kit";

test("constantTimeEqual: equal, unequal, non-string", async () => {
  assert.equal(await constantTimeEqual("abc", "abc"), true);
  assert.equal(await constantTimeEqual("abc", "abd"), false);
  assert.equal(await constantTimeEqual("abc", 42), false);
});

test("readTextBody enforces the byte cap", async () => {
  const under = new Request("http://x/", { method: "POST", body: "a".repeat(10) });
  assert.deepEqual(await readTextBody(under, 16), { ok: true, text: "a".repeat(10) });
  const over = new Request("http://x/", { method: "POST", body: "a".repeat(32) });
  assert.deepEqual(await readTextBody(over, 16), { ok: false });
});

test("safeString rejects newlines, delimiters, and over-length", () => {
  assert.equal(safeString("plain", 16), "plain");
  assert.equal(safeString("bad=value", 16), null);
  assert.equal(safeString("line\nbreak", 16), null);
  assert.equal(safeString("a".repeat(17), 16), null);
  assert.equal(safeString("", 16), null);
});
