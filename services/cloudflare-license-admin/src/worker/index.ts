// Cloudflare module adapter: composition is deliberately kept out of the entrypoint.
import { adminApp } from "./app.js";

export default adminApp;
export { API_BINDING_KEYS, adminInternalsForTests } from "./operations.js";
export type { Env } from "./env.js";
