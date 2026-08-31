import assert from "node:assert/strict";
import test from "node:test";
import { worker } from "./fixtures.mjs";
import { assertRouteGroup } from "./route-group-assertions.mjs";

test("meta routes have direct public owners", () => assertRouteGroup("meta", 2));

test("meta routes remain public and serve their canonical formats", async () => {
  for (const [pathname, contentType] of [
    ["/openapi.json", /^application\/json/],
    ["/docs", /^text\/html/],
  ]) {
    const response = await worker.fetch(new Request(`https://admin.example${pathname}`), { DB: {} });
    assert.equal(response.status, 200, `${pathname} must remain public`);
    assert.match(response.headers.get("content-type") ?? "", contentType);
    assert.ok((await response.text()).length > 0, `${pathname} must not become an empty response`);
  }
});

test("the docs renderer does not ship a DOM HTML injection sink", async () => {
  const response = await worker.fetch(new Request("https://admin.example/docs"), { DB: {} });
  assert.equal(response.status, 200);
  const policy = response.headers.get("content-security-policy") ?? "";
  const nonce = /script-src 'nonce-([^']+)'/u.exec(policy)?.[1];
  assert.ok(nonce);
  assert.doesNotMatch(policy, /unsafe-(?:inline|eval)/u);
  const html = await response.text();
  assert.equal(html.split(`nonce="${nonce}"`).length - 1, 2);
  assert.doesNotMatch(html, /innerHTML/u);
});
