// Thin module-worker entrypoint. Composition and route ownership live in app.ts.
export { default, PORTAL_ROUTE_KEYS, portalInternalsForTests } from "./app.js";
export type { Env } from "./env.js";
