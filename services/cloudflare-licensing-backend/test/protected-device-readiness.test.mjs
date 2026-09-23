import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { checkProtectedDeviceConfiguration, main } from "../scripts/protected-device-readiness.mjs";

const algorithm = { name:"RSASSA-PKCS1-v1_5", modulusLength:3072, publicExponent:new Uint8Array([1,0,1]), hash:"SHA-256" };
const pem = (label, bytes) => `-----BEGIN ${label}-----\n${Buffer.from(bytes).toString("base64")}\n-----END ${label}-----`;
async function configuration() {
  const keys = await crypto.subtle.generateKey(algorithm, true, ["sign","verify"]);
  return {
    BOUND_DEVICE_CONFIG: JSON.stringify({issuer:"https://licenses.example.test/",audience:"desktop",
      authorization_url:"https://portal.example.test/connect",clients:[{client_id:"desktop",project:"APP",
        display_name:"Example",callbacks:[{host:"127.0.0.1",path:"/callback"}]}]}),
    BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM: pem("PRIVATE KEY",await crypto.subtle.exportKey("pkcs8",keys.privateKey)),
    BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM: pem("PUBLIC KEY",await crypto.subtle.exportKey("spki",keys.publicKey)),
    BOUND_APPROVAL_ENCRYPTION_KEYS:JSON.stringify({active:"a1",keys:{a1:Buffer.alloc(32,7).toString("base64url")}}),
  };
}
test("protected readiness proves local crypto/configuration without claiming live issuance", async () => {
  const env = await configuration();
  const result = await checkProtectedDeviceConfiguration(env);
  assert.equal(result.ok,true);
  assert.equal(result.scope,"local_configuration_only");
  assert.equal(result.live_issuance,"not_run");
  assert.equal(result.live_renewal,"not_run");
  assert.deepEqual(result.checks,{registry:true,signing_key_pair:true,approval_key_ring:true,global_rate_limit:true});
  for (const field of Object.keys(env)) {
    const broken = {...env}; delete broken[field];
    assert.equal((await checkProtectedDeviceConfiguration(broken)).ok,false,field);
  }
  const other = await configuration();
  const mismatch = await checkProtectedDeviceConfiguration({...env,BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM:other.BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM});
  assert.equal(mismatch.ok,false);
  assert.equal(mismatch.checks.signing_key_pair,false);
  assert.doesNotMatch(JSON.stringify(mismatch),/PRIVATE KEY|PUBLIC KEY|a1|licenses\.example/);
  assert.equal((await checkProtectedDeviceConfiguration({...env,BOUND_APPROVAL_ENCRYPTION_KEYS:'{"active":"missing","keys":{}}'})).ok,false);
});

test("protected readiness flags an out-of-range or non-integer global rate limit as its own failure", async () => {
  const env = await configuration();
  for (const invalid of ["0", "99", "1000001", "12.5", "not-a-number", "", "-5", "NaN", "Infinity"]) {
    const result = await checkProtectedDeviceConfiguration({...env, BOUND_GLOBAL_RATE_LIMIT: invalid});
    assert.equal(result.ok, false, invalid);
    assert.deepEqual(result.checks, {registry:true,signing_key_pair:true,approval_key_ring:true,global_rate_limit:false}, invalid);
  }
  for (const valid of ["100", "1000", "1000000", "500", 500]) {
    const result = await checkProtectedDeviceConfiguration({...env, BOUND_GLOBAL_RATE_LIMIT: valid});
    assert.equal(result.ok, true, String(valid));
    assert.equal(result.checks.global_rate_limit, true, String(valid));
  }
  // Unset keeps the documented default (1000) and is not a failure.
  assert.equal((await checkProtectedDeviceConfiguration(env)).checks.global_rate_limit, true);
});

test("readiness script supports environment-scoped Wrangler vars", async (t) => {
  const tempDir = `${import.meta.dirname}/.temp-readiness-${crypto.randomUUID()}`;
  try {
    await mkdir(tempDir, { recursive: true });
    const protectedVars = await configuration();
    const secrets = { };

    const configPath = `${tempDir}/config.json`;
    const secretsPath = `${tempDir}/secrets.json`;

    // Config with empty top-level vars and valid protected settings in env.production.vars
    const config = {
      vars: {},
      env: {
        production: {
          vars: protectedVars
        }
      }
    };

    await writeFile(configPath, JSON.stringify(config));
    await writeFile(secretsPath, JSON.stringify(secrets));

    // Test 1: --env=production should return 0 (success)
    const result1 = await main([`--config=${configPath}`, `--secrets=${secretsPath}`, "--env=production"]);
    assert.equal(result1, 0, "should succeed with --env=production");

    // Test 2: without --env should return 1 (fail because checkProtectedDeviceConfiguration rejects empty vars)
    const result2 = await main([`--config=${configPath}`, `--secrets=${secretsPath}`]);
    assert.equal(result2, 1, "should fail without --env");

    // Test 3: --env=staging (missing) should return 1 with error protected_configuration_unavailable
    const chunks = [];
    t.mock.method(process.stdout, "write", (chunk) => {
      chunks.push(chunk);
      return true;
    });
    const result3 = await main([`--config=${configPath}`, `--secrets=${secretsPath}`, "--env=staging"]);
    assert.equal(result3, 1, "should fail with non-existent --env=staging");
    const output = chunks.join("");
    const parsed = JSON.parse(output);
    assert.equal(parsed.ok, false, "response should have ok=false");
    assert.equal(parsed.error, "protected_configuration_unavailable", "response should have error protected_configuration_unavailable");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
