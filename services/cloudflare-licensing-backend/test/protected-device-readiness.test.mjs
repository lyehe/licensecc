import { test } from "node:test";
import assert from "node:assert/strict";
import { checkProtectedDeviceConfiguration } from "../scripts/protected-device-readiness.mjs";

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
  assert.deepEqual(result.checks,{registry:true,signing_key_pair:true,approval_key_ring:true});
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
