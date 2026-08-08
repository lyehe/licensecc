import assert from "node:assert/strict";
import { ROUTE_DESCRIPTORS } from "../../dist-worker/worker/dispatch.js";
import worker from "../../dist-worker/worker/index.js";

export function assertRouteGroup(group, minimumRoutes) {
  const descriptors = ROUTE_DESCRIPTORS.filter((descriptor) => descriptor.group === group);
  assert.ok(descriptors.length >= minimumRoutes, `${group} has no route ownership`);
  for (const descriptor of descriptors) {
    assert.equal(typeof descriptor.handle, "function", `${descriptor.method} ${descriptor.path} lacks a direct handler`);
    assert.deepEqual(
      descriptor.paramNames,
      [...descriptor.path.matchAll(/\{([^/}]+)\}/g)].map((match) => match[1]),
      `${descriptor.method} ${descriptor.path} parameter names drifted from its template`,
    );
  }
}

export async function assertRouteGroupRejectsUnauthenticated(group) {
  const descriptors = ROUTE_DESCRIPTORS.filter((descriptor) => descriptor.group === group);
  assert.ok(descriptors.length > 0, `${group} has no routes to characterize`);
  for (const descriptor of descriptors) {
    assert.notEqual(descriptor.authorization, "public", `${descriptor.method} ${descriptor.path} is unexpectedly public`);
    const pathname = descriptor.path.replace(/\{[^/}]+\}/g, "raw%2Fcapture");
    const response = await worker.fetch(
      new Request(`https://admin.example${pathname}`, { method: descriptor.method }),
      { DB: {} },
    );
    assert.equal(response.status, 401, `${descriptor.method} ${descriptor.path} bypassed authentication`);
    const body = await response.json();
    assert.equal(
      body.code,
      descriptor.authorization === "sync" ? "sync_auth_not_configured" : "admin_auth_not_configured",
      `${descriptor.method} ${descriptor.path} reached a handler before authentication`,
    );
  }
}
