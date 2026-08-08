import test from "node:test";
import { assertRouteGroup } from "./route-group-assertions.mjs";
test("catalog routes have direct owners", () => assertRouteGroup("catalog", 20));
