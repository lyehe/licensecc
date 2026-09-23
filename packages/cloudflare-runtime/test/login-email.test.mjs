import test from "node:test";
import assert from "node:assert/strict";
import { loginEmail } from "../src/auth/password.mjs";

test("login emails accept plain addresses and reject header/list syntax", () => {
  assert.equal(loginEmail(" Alice.B+tag@Example.co.uk "), "alice.b+tag@example.co.uk");
  for (const value of ['"x"<attacker@evil.com>', "a,b@x.com", "a;b@x.com", "a@x.com>", "<a@x.com", "a(b)@x.com", "a:b@x.com", "a\\b@x.com", "a[b]@x.com", "a\u0000b@x.com", "a@x\u007f.com", "a\u0080b@x.com", "a@x\u0085.com", "a\u009fb@x.com"]) {
    assert.equal(loginEmail(value), null, value);
  }
});
