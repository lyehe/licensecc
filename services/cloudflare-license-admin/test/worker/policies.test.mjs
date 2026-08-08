import test from "node:test";
import { assertRouteGroup } from "./route-group-assertions.mjs";
test("policy routes have direct owners", () => assertRouteGroup("policies", 6));
