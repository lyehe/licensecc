import assert from "node:assert/strict";
import test from "node:test";

import { parseSupportContact } from "../src/portal/support_contact.mjs";

test("support contact accepts a single mailbox or credential-free HTTPS link", () => {
  assert.equal(parseSupportContact("mailto:help@example.invalid"), "mailto:help@example.invalid");
  assert.equal(parseSupportContact("https://EXAMPLE.invalid/support?q=license"), "https://example.invalid/support?q=license");
});

test("support contact rejects unsafe schemes, URL credentials and mailbox lists or queries", () => {
  for (const value of [
    "", "/support", "http://example.invalid", "javascript:alert(1)",
    "https://operator:secret@example.invalid/support", "https://operator@example.invalid/support",
    "mailto:first@example.invalid,second@example.invalid", "mailto:first@example.invalid;second@example.invalid",
    "mailto:help@example.invalid?subject=license", "mailto:help%3bother@example.invalid",
    "mailto:help\n@example.invalid", "mailto:help\u0000@example.invalid",
  ]) {
    assert.equal(parseSupportContact(value), null, JSON.stringify(value));
  }
});
