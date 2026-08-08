import test from "node:test";
import { assertRouteGroup } from "./route-group-assertions.mjs";
test("device and seat routes have direct owners", () => assertRouteGroup("devices", 6));
