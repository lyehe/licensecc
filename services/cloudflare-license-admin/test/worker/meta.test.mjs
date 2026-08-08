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
