import test from "node:test";
import { assertRouteGroup } from "./route-group-assertions.mjs";
test("meta routes have direct public owners", () => assertRouteGroup("meta", 2));
