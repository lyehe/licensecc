import assert from "node:assert/strict";
import { ROUTE_DESCRIPTORS } from "../../dist-worker/worker/dispatch.js";

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
