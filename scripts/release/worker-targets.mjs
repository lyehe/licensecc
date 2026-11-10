export const WORKER_TARGETS = Object.freeze([
  Object.freeze({
    id: "backend",
    env: "LICENSECC_BACKEND_WRANGLER_CONFIG_B64",
    path: "services/cloudflare-licensing-backend/wrangler.toml",
    format: "toml",
    main: "src/index.ts",
  }),
  Object.freeze({
    id: "admin",
    env: "LICENSECC_ADMIN_WRANGLER_CONFIG_B64",
    path: "services/cloudflare-license-admin/wrangler.jsonc",
    format: "jsonc",
    main: "src/worker/index.ts",
  }),
  Object.freeze({
    id: "portal",
    env: "LICENSECC_PORTAL_WRANGLER_CONFIG_B64",
    path: "services/cloudflare-customer-portal/wrangler.jsonc",
    format: "jsonc",
    main: "src/worker/index.ts",
  }),
  Object.freeze({
    id: "backup",
    env: "LICENSECC_BACKUP_WRANGLER_CONFIG_B64",
    path: "services/cloudflare-d1-backup/wrangler.jsonc",
    format: "jsonc",
    main: "src/index.ts",
  }),
]);

export const WORKER_CONFIGS = Object.freeze(Object.fromEntries(WORKER_TARGETS.map(({ id, path }) => [id, path])));
