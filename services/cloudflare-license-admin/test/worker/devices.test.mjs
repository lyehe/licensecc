import test from "node:test";
import { assertRouteGroup, assertRouteGroupRejectsUnauthenticated } from "./route-group-assertions.mjs";

test("device and seat routes have direct owners and reject anonymous access", async () => {
  assertRouteGroup("devices", 6);
  await assertRouteGroupRejectsUnauthenticated("devices");
});
