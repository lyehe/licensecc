import test from "node:test";
import { assertRouteGroup } from "./route-group-assertions.mjs";
test("webhook routes have direct owners", () => assertRouteGroup("webhooks", 8));
