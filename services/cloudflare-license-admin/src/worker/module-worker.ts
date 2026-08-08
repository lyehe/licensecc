// Cloudflare module adapter: keep the public Worker surface out of the entrypoint.
import { adminApp } from "./app.js";
import { API_BINDING_KEYS, adminInternalsForTests } from "./operations.js";
import type { Env } from "./env.js";

export { adminApp, API_BINDING_KEYS, adminInternalsForTests };
export type { Env };
export default adminApp;
