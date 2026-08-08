import test from "node:test";
import { assertRouteGroup, assertRouteGroupRejectsUnauthenticated } from "./route-group-assertions.mjs";

test("webhook routes have direct owners and reject anonymous access", async () => {
  assertRouteGroup("webhooks", 8);
  await assertRouteGroupRejectsUnauthenticated("webhooks");
});
