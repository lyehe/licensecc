import test from "node:test";
import { assertRouteGroup } from "./route-group-assertions.mjs";
test("entitlement routes have direct owners", () => assertRouteGroup("entitlements", 9));
