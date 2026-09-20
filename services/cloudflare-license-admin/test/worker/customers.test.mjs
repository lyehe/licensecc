import test from "node:test";
import { assertRouteGroup, assertRouteGroupRejectsUnauthenticated } from "./route-group-assertions.mjs";

test("customer routes have direct owners and reject anonymous access", async () => {
  assertRouteGroup("customers", 11);
  await assertRouteGroupRejectsUnauthenticated("customers");
});
