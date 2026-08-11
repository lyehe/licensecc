import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import {
  BodyTooLargeError,
  PG_MAX_BODY_BYTES,
  createNodeRequestToWeb,
  createPgHttpHandler,
  readNodeBody,
} from "./pg-http-handler.mjs";

function response() {
  return {
    status: null,
    headers: {},
    body: "",
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(body = "") { this.body = String(body); },
  };
}

function requestEmitter({ method = "POST", url = "/v1/verify", headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = {};
  req.paused = 0;
  req.resumed = 0;
  req.pause = () => { req.paused += 1; };
  req.resume = () => { req.resumed += 1; };
  return req;
}

function handler(overrides = {}) {
  const counters = { adapted: 0, fetched: 0, env: 0 };
  const result = createPgHttpHandler({
    worker: { fetch: async () => { counters.fetched += 1; return new Response("ok"); } },
    buildEnv: () => { counters.env += 1; return {}; },
    nodeRequestToWeb: async () => { counters.adapted += 1; return new Request("https://example.test/v1/verify"); },
    webResponseToNode: async () => {},
    ...overrides,
  });
  return { handler: result, counters };
}

async function withHttpServer(callback) {
  const { handler: route } = handler({
    worker: { fetch: async () => assert.fail("worker must not run for an oversized request") },
    nodeRequestToWeb: (req) => readNodeBody(req),
  });
  const server = createServer(route);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await callback(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function chunkedRequest(port, chunks) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/v1/verify", method: "POST" }, (res) => {
      const body = [];
      res.on("data", (chunk) => body.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(body).toString("utf8") }));
    });
    req.once("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test("PG handler rejects unsupported method/path before body, Worker, env, or DB-facing work", async () => {
  const { handler: route, counters } = handler();
  const req = requestEmitter({ url: "/v1/orders" });
  const res = response();
  await route(req, res);
  assert.equal(res.status, 501);
  assert.deepEqual(JSON.parse(res.body), { ok: false, code: "not_supported_on_postgres_adapter" });
  assert.deepEqual(counters, { adapted: 0, fetched: 0, env: 0 });
  assert.equal(req.listenerCount("data"), 0);
});

test("declared oversized verify body is rejected before subscribing to input", async () => {
  const { handler: route, counters } = handler();
  const req = requestEmitter({ headers: { "content-length": String(PG_MAX_BODY_BYTES + 1) } });
  const res = response();
  await route(req, res);
  assert.equal(res.status, 413);
  assert.equal(res.headers.connection, "close");
  assert.deepEqual(JSON.parse(res.body), { ok: false, code: "body_too_large" });
  assert.deepEqual(counters, { adapted: 0, fetched: 0, env: 0 });
  assert.equal(req.listenerCount("data"), 0);
  assert.equal(req.resumed, 1);
});

test("chunked overflow returns a readable HTTP 413 instead of resetting the client", async () => {
  await withHttpServer(async (port) => {
    const result = await chunkedRequest(port, [Buffer.alloc(PG_MAX_BODY_BYTES), Buffer.from("x")]);
    assert.equal(result.status, 413);
    assert.deepEqual(JSON.parse(result.body), { ok: false, code: "body_too_large" });
  });
});

test("body reader preserves the exact boundary and removes every listener", async () => {
  const req = requestEmitter();
  const pending = readNodeBody(req);
  req.emit("data", Buffer.alloc(PG_MAX_BODY_BYTES));
  req.emit("end");
  assert.equal((await pending).length, PG_MAX_BODY_BYTES);
  for (const event of ["data", "end", "error", "aborted"]) assert.equal(req.listenerCount(event), 0);
});

test("body reader propagates stream failures and removes every listener", async () => {
  const req = requestEmitter();
  const expected = new Error("socket failed");
  const pending = readNodeBody(req);
  req.emit("error", expected);
  await assert.rejects(pending, (error) => error === expected);
  for (const event of ["data", "end", "error", "aborted"]) assert.equal(req.listenerCount(event), 0);
});

test("node adapter reconstructs URL/body and replaces every client-supplied IP header", async () => {
  const req = requestEmitter({
    url: "/v1/verify?mode=strict",
    headers: {
      host: "licenses.example.test",
      "content-type": "application/json",
      "cf-connecting-ip": "198.51.100.1",
      "x-forwarded-for": "198.51.100.2",
      "x-trace": ["one", "two"],
    },
  });
  req.socket.encrypted = true;
  const adapt = createNodeRequestToWeb({
    defaultHost: "127.0.0.1:8787",
    clientIpHeaders: ["cf-connecting-ip", "x-forwarded-for"],
    clientIpFromRequest: () => "203.0.113.9",
  });
  const pending = adapt(req);
  req.emit("data", Buffer.from('{"ok":true}'));
  req.emit("end");
  const request = await pending;
  assert.equal(request.url, "https://licenses.example.test/v1/verify?mode=strict");
  assert.equal(request.headers.get("cf-connecting-ip"), "203.0.113.9");
  assert.equal(request.headers.has("x-forwarded-for"), false);
  assert.equal(request.headers.get("x-trace"), "one, two");
  assert.equal(await request.text(), '{"ok":true}');
  assert.ok(BodyTooLargeError.prototype instanceof Error);
});
