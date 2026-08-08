import test from "node:test";
import { assertRouteGroup } from "./route-group-assertions.mjs";
test("sync route has a direct owner", () => assertRouteGroup("sync", 1));
