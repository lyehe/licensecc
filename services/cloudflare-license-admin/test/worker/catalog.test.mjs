import test from "node:test";
import { assertRouteGroup, assertRouteGroupRejectsUnauthenticated } from "./route-group-assertions.mjs";

test("catalog routes have direct owners and reject anonymous access", async () => {
  assertRouteGroup("catalog", 20);
  await assertRouteGroupRejectsUnauthenticated("catalog");
});
