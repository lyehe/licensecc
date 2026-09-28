import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_WEBHOOK_URL_SIZE,
  safeWebhookUrl,
  WEBHOOK_TEST_STATUS_CLASSES,
} from "../src/webhooks/webhook_endpoint.mjs";
import { WEBHOOK_DELIVER_TIMEOUT_MS, webhookSigningConfig } from "../src/webhooks/webhook.mjs";

test("safeWebhookUrl accepts an absolute https URL and returns its normalized href", () => {
  assert.equal(safeWebhookUrl("https://hooks.example.com/lcc"), "https://hooks.example.com/lcc");
  assert.equal(safeWebhookUrl("https://HOOKS.example.com"), "https://hooks.example.com/");
});

test("safeWebhookUrl rejects every non-https scheme", () => {
  for (const url of ["http://hooks.example.com/lcc", "ftp://hooks.example.com/", "file:///etc/passwd", "data:text/plain,x", "javascript:alert(1)"]) {
    assert.equal(safeWebhookUrl(url), null, url);
  }
});

test("safeWebhookUrl rejects non-strings, blanks, whitespace, control characters and oversize values", () => {
  for (const value of [undefined, null, 42, {}, "", "not a url", "https://hooks.example.com/a b", "https://hooks.example.com/\n", "https://hooks.example.com/\0"]) {
    assert.equal(safeWebhookUrl(value), null, JSON.stringify(value));
  }
  const prefix = "https://hooks.example.com/";
  assert.equal(safeWebhookUrl(prefix + "a".repeat(MAX_WEBHOOK_URL_SIZE - prefix.length)), prefix + "a".repeat(MAX_WEBHOOK_URL_SIZE - prefix.length));
  assert.equal(safeWebhookUrl(prefix + "a".repeat(MAX_WEBHOOK_URL_SIZE - prefix.length + 1)), null);
});

test("safeWebhookUrl refuses credentials, IP literals and internal hostnames", () => {
  for (const url of [
    "https://user:pass@hooks.example.com/", "https://user@hooks.example.com/",
    "https://127.0.0.1/", "https://10.0.0.5/hook", "https://[::1]/", "https://[fd00::1]/",
    "https://localhost/", "https://api.localhost/", "https://intranet/", "https://printer.local/",
    "https://db.internal/", "https://nas.home.arpa/",
  ]) {
    assert.equal(safeWebhookUrl(url), null, url);
  }
  assert.equal(safeWebhookUrl("https://hooks.example.com:8443/lcc"), "https://hooks.example.com:8443/lcc");
});

test("safeWebhookUrl refuses a trailing-dot host and stays closed against numeric IPv4 spellings", () => {
  for (const url of [
    // A trailing dot names the DNS root but must not slip past the internal-suffix or
    // single-label checks.
    "https://localhost./", "https://api.localhost./", "https://printer.local./",
    "https://db.internal./", "https://nas.home.arpa./", "https://intranet./", "https://localhost../",
    "https://home.arpa/",
    // Already refused by the IP-literal/IPv6 checks (the URL parser canonicalizes each of these
    // to a dotted-quad or bracketed IPv6 literal before safeWebhookUrl ever sees the hostname).
    "https://2130706433/", "https://0x7f.1/", "https://127.1/", "https://127.0.0.1./",
    "https://[::ffff:127.0.0.1]/",
  ]) {
    assert.equal(safeWebhookUrl(url), null, url);
  }
  assert.equal(safeWebhookUrl("https://hooks.example.com:8443/lcc"), "https://hooks.example.com:8443/lcc");
});

test("a test send can only ever report one of five status classes", () => {
  assert.deepEqual([...WEBHOOK_TEST_STATUS_CLASSES], ["2xx", "3xx", "4xx", "5xx", "network_error"]);
  assert.ok(Object.isFrozen(WEBHOOK_TEST_STATUS_CLASSES));
});

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
