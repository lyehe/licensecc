import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { materializeDeploymentConfigs } from "./materialize-deploy-configs.mjs";

const encoded = (value) => Buffer.from(value, "utf8").toString("base64");

function validEnvironment() {
  return {
    LICENSECC_BACKEND_WRANGLER_CONFIG_B64: encoded('name = "licensecc-online-verifier"\nmain = "src/index.ts"\nREQUEST_SIGNATURE_MODE = "required"\nACCOUNT_TOKEN_MODE = "required"\nORDER_INGEST_MODE = "required"\n[[d1_databases]]\nbinding = "DB"\ndatabase_id = "real-id"\n'),
    LICENSECC_ADMIN_WRANGLER_CONFIG_B64: encoded('{"name":"licensecc-admin","main":"src/worker/index.ts","d1_databases":[{"binding":"DB","database_id":"real-id"}],"vars":{"ENVIRONMENT":"production","ADMIN_DEV_BEARER_ENABLED":"0"}}'),
    LICENSECC_PORTAL_WRANGLER_CONFIG_B64: encoded('{"name":"licensecc-customer-portal","main":"src/worker/index.ts","d1_databases":[{"binding":"DB","database_id":"real-id"}],"vars":{"ENVIRONMENT":"production","PORTAL_PUBLIC_ORIGIN":"https://portal.invalid","BACKEND_ORIGIN":"https://backend.invalid"}}'),
    LICENSECC_BACKUP_WRANGLER_CONFIG_B64: encoded('{"name":"licensecc-d1-backup","workflows":[{"binding":"D1_BACKUP_WORKFLOW"}],"r2_buckets":[{"binding":"BACKUP_BUCKET"}]}'),
  };
}

test("materializes exactly four production configs with no plaintext Worker secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "licensecc-deploy-configs-"));
  try {
    const written = materializeDeploymentConfigs({ root, environment: validEnvironment() });
    assert.equal(written.length, 4);
    assert.match(readFileSync(join(root, "services/cloudflare-licensing-backend/wrangler.toml"), "utf8"), /REQUEST_SIGNATURE_MODE = "required"/u);
    assert.match(readFileSync(join(root, "services/cloudflare-license-admin/wrangler.jsonc"), "utf8"), /"ENVIRONMENT":"production"/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects missing, malformed, placeholder, unsafe-mode, and secret-bearing config inputs", () => {
  const cases = [
    ["missing", (env) => { delete env.LICENSECC_BACKEND_WRANGLER_CONFIG_B64; }, /strict base64/u],
    ["noncanonical base64", (env) => { env.LICENSECC_BACKEND_WRANGLER_CONFIG_B64 = "YQ"; }, /strict base64|canonical/u],
    ["placeholder", (env) => { env.LICENSECC_BACKUP_WRANGLER_CONFIG_B64 = encoded('{"name":"licensecc-d1-backup","database_id":"replace-with-id","workflows":[{"binding":"D1_BACKUP_WORKFLOW"}],"r2_buckets":[{"binding":"BACKUP_BUCKET"}]}'); }, /placeholder/u],
    ["development admin", (env) => { env.LICENSECC_ADMIN_WRANGLER_CONFIG_B64 = encoded('{"name":"licensecc-admin","d1_databases":[{"binding":"DB"}],"vars":{"ENVIRONMENT":"development","ADMIN_DEV_BEARER_ENABLED":"1"}}'); }, /production|ADMIN_DEV/u],
    ["plaintext secret", (env) => { env.LICENSECC_BACKEND_WRANGLER_CONFIG_B64 = encoded('name = "licensecc-online-verifier"\nREQUEST_SIGNATURE_MODE = "required"\nACCOUNT_TOKEN_MODE = "required"\nORDER_INGEST_MODE = "required"\nbinding = "DB"\nORDER_HMAC_SECRETS = "plaintext"\n'); }, /Worker secret/u],
    ["comment decoy", (env) => { env.LICENSECC_ADMIN_WRANGLER_CONFIG_B64 = encoded('{"name":"licensecc-admin","d1_databases":[{"binding":"DB"}] /* "ENVIRONMENT":"production", "ADMIN_DEV_BEARER_ENABLED":"0" */}'); }, /production|ADMIN_DEV/u],
    ["inline comment decoy", (env) => { env.LICENSECC_BACKEND_WRANGLER_CONFIG_B64 = encoded('name = "licensecc-online-verifier"\nbinding = "DB"\n# REQUEST_SIGNATURE_MODE = "required"\nACCOUNT_TOKEN_MODE = "required"\nORDER_INGEST_MODE = "required"\n'); }, /REQUEST_SIGNATURE_MODE/u],
  ];
  for (const [name, mutate, pattern] of cases) {
    const root = mkdtempSync(join(tmpdir(), "licensecc-deploy-configs-negative-"));
    try {
      const environment = validEnvironment();
      mutate(environment);
      assert.throws(() => materializeDeploymentConfigs({ root, environment }), pattern, name);
      assert.equal(existsSync(join(root, "services/cloudflare-licensing-backend/wrangler.toml")), false,
        `${name} must fail before any config is written`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("rolls back only files created by a partial write failure", () => {
  const root = mkdtempSync(join(tmpdir(), "licensecc-deploy-configs-rollback-"));
  try {
    const blocked = join(root, "services/cloudflare-license-admin/wrangler.jsonc");
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(blocked, "owned-by-fixture"), "keep", "utf8");
    assert.throws(() => materializeDeploymentConfigs({ root, environment: validEnvironment() }));
    assert.equal(existsSync(join(root, "services/cloudflare-licensing-backend/wrangler.toml")), false);
    assert.equal(readFileSync(join(blocked, "owned-by-fixture"), "utf8"), "keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
