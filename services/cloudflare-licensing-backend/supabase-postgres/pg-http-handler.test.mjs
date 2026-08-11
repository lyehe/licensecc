import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { BodyTooLargeError, PG_MAX_BODY_BYTES, createPgHttpHandler, readNodeBody } from "./pg-http-handler.mjs";

function response() { return { status: null, body: "", writeHead(status) { this.status = status; }, end(body = "") { this.body = body; } }; }

test("PG handler rejects unsupported method/path before Worker or body adapter", async () => {
  let adapted = 0; let fetched = 0;
  const handler = createPgHttpHandler({ worker: { fetch: async () => { fetched += 1; } }, buildEnv: () => ({}), nodeRequestToWeb: async () => { adapted += 1; }, webResponseToNode: async () => {} });
  const res = response(); await handler({ method: "POST", url: "/v1/orders" }, res);
  assert.equal(res.status, 501); assert.equal(adapted, 0); assert.equal(fetched, 0);
});

test("PG handler converts oversized chunked supported body to 413 and cancels input", async () => {
  const req = new EventEmitter(); req.method = "POST"; req.url = "/v1/verify"; let destroyed = false; req.destroy = () => { destroyed = true; };
  const handler = createPgHttpHandler({ worker: { fetch: async () => assert.fail("worker must not run") }, buildEnv: () => ({}), nodeRequestToWeb: (input) => readNodeBody(input), webResponseToNode: async () => {} });
  const res = response(); const pending = handler(req, res); req.emit("data", Buffer.alloc(PG_MAX_BODY_BYTES)); req.emit("data", Buffer.from("x")); await pending;
  assert.equal(res.status, 413); assert.equal(destroyed, true);
});

test("body reader preserves supported payloads at the 4 KiB boundary", async () => {
  const req = new EventEmitter(); const pending = readNodeBody(req); req.emit("data", Buffer.alloc(PG_MAX_BODY_BYTES)); req.emit("end"); assert.equal((await pending).length, PG_MAX_BODY_BYTES);
  assert.ok(BodyTooLargeError);
});
