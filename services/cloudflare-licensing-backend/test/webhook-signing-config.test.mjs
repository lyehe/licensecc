import assert from "node:assert/strict";
import test from "node:test";
import { WEBHOOK_DELIVER_TIMEOUT_MS, webhookSigningConfig } from "../src/webhooks/webhook.mjs";

test("webhookSigningConfig is the one fail-closed signing selector real and test deliveries share", () => {
  const secret = Buffer.alloc(32, 7).toString("base64");
  const configured = webhookSigningConfig({ WEBHOOK_SIGNING_SECRETS: JSON.stringify({ k1: secret }), WEBHOOK_SIGNING_KEY_ID: "k1" });
  assert.equal(configured.keyId, "k1");
  assert.ok(configured.secretsMap !== null && typeof configured.secretsMap === "object");
  assert.equal(webhookSigningConfig({}).error, "webhook.signing_unconfigured");
  assert.equal(webhookSigningConfig(undefined).error, "webhook.signing_unconfigured");
  assert.equal(webhookSigningConfig({ WEBHOOK_SIGNING_SECRETS: JSON.stringify({ k1: secret }) }).error, "webhook.signing_key_missing");
  assert.equal(webhookSigningConfig({ WEBHOOK_SIGNING_SECRETS: JSON.stringify({ k1: secret }), WEBHOOK_SIGNING_KEY_ID: "k2" }).error, "webhook.signing_key_missing");
  assert.equal(WEBHOOK_DELIVER_TIMEOUT_MS, 5000);
});
