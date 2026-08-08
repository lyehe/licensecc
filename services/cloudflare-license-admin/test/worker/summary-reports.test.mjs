import test from "node:test";
import { assertRouteGroup } from "./route-group-assertions.mjs";
test("summary and report routes have direct owners", () => assertRouteGroup("summary-reports", 6));
