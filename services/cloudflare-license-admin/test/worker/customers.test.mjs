import test from "node:test";
import { assertRouteGroup } from "./route-group-assertions.mjs";
test("customer routes have direct owners", () => assertRouteGroup("customers", 7));
