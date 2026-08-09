import assert from "node:assert/strict";
import test from "node:test";

import { deliverWebhooks, WEBHOOK_ERROR_BODY_MAX_BYTES } from "../src/webhooks/webhook.mjs";

const SECRET_B64 = Buffer.alloc(32, 7).toString("base64");
const SIGNING_ENV = {
  WEBHOOK_SIGNING_SECRETS: JSON.stringify({ k1: SECRET_B64 }),
  WEBHOOK_SIGNING_KEY_ID: "k1",
};

function makeDelivery(overrides = {}) {
  return {
    id: 17,
    endpoint_id: "ep1",
    event_source: "customer",
    event_id: 1,
    event_type: "disable",
    payload_json: '{"ok":true}',
    attempts: 0,
    url: "https://hook.test/ep1",
    ...overrides,
  };
}

function makeEnvironment(overrides = {}) {
  const row = makeDelivery(overrides.delivery);
  const state = { ...row, last_status: 0, last_error: "", next_attempt_at: 0, status: "pending" };
  const db = {
    prepare(sql) {
      if (sql.includes("FROM webhook_deliveries")) {
        return {
          bind() {
            return { all: async () => ({ results: [state] }) };
          },
        };
      }
      if (sql.startsWith("UPDATE webhook_deliveries")) {
        return {
          bind(...values) {
            return {
              run: async () => {
                if (sql.includes("status = 'delivered'")) {
                  state.status = "delivered";
                  state.attempts += 1;
                  state.last_status = values[0];
                  state.last_error = "";
                  state.delivered_at = values[1];
                } else if (sql.includes("status = 'failed'")) {
                  state.status = "failed";
                  state.attempts = values[0];
                  state.last_status = values[1];
                  state.last_error = values[2];
                } else {
                  state.attempts = values[0];
                  state.last_status = values[1];
                  state.last_error = values[2];
                  state.next_attempt_at = values[3];
                }
              },
            };
          },
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { env: { ...SIGNING_ENV, ...overrides.env, DB: db }, state };
}

function streamedResponse(chunks, { status = 500, keepOpen = false, error } = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  let reads = 0;
  let cancelled = false;
  let cancelReason;
  let textCalls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        if (error !== undefined) {
          controller.error(error);
        } else if (!keepOpen) {
          controller.close();
        }
        return;
      }
      controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    },
    cancel(reason) {
      cancelled = true;
      cancelReason = reason;
    },
  });
  const body = {
    getReader() {
      const reader = stream.getReader();
      return {
        async read() {
          reads += 1;
          return reader.read();
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
        releaseLock() {
          reader.releaseLock();
        },
      };
    },
  };
  return {
    status,
    body,
    async text() {
      textCalls += 1;
      const reader = body.getReader();
      const values = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          values.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(values.reduce((size, value) => size + value.byteLength, 0));
      let offset = 0;
      for (const value of values) {
        bytes.set(value, offset);
        offset += value.byteLength;
      }
      return new TextDecoder().decode(bytes);
    },
    get reads() {
      return reads;
    },
    get cancelled() {
      return cancelled;
    },
    get cancelReason() {
      return cancelReason;
    },
    get textCalls() {
      return textCalls;
    },
  };
}

async function deliverWith(fetchResult, overrides = {}) {
  const { env, state } = makeEnvironment(overrides);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => fetchResult;
  try {
    await deliverWebhooks(env, 200, () => {});
  } finally {
    globalThis.fetch = originalFetch;
  }
  return state;
}

test("non-2xx diagnostic at the byte cap preserves the 256-character shape", async () => {
  const response = streamedResponse(["x".repeat(WEBHOOK_ERROR_BODY_MAX_BYTES)]);
  const state = await deliverWith(response);

  assert.equal(response.reads, 1);
  assert.equal(response.textCalls, 0);
  assert.equal(state.last_error, "x".repeat(256));
  assert.equal(state.last_error.length, 256);
});

test("non-2xx diagnostic cancels an oversized chunked response at the byte cap", async () => {
  const response = streamedResponse([
    "a".repeat(WEBHOOK_ERROR_BODY_MAX_BYTES - 1),
    "b",
    "c".repeat(10_000),
  ]);
  const state = await deliverWith(response);

  assert.equal(response.reads, 2);
  assert.equal(response.textCalls, 0);
  assert.equal(response.cancelled, true);
  assert.ok(response.cancelReason !== undefined);
  assert.equal(state.last_error, "a".repeat(256));
});

test("normal UTF-8 diagnostics retain the existing 256-character truncation", async () => {
  const state = await deliverWith(streamedResponse(["é".repeat(300)]));

  assert.equal(state.last_error, "é".repeat(256));
});

test("empty and erroring response bodies remain retryable with an empty diagnostic", async () => {
  const empty = await deliverWith({ status: 503, body: null, text: async () => "" });
  assert.equal(empty.last_error, "");
  assert.equal(empty.attempts, 1);

  const erroring = streamedResponse([], { error: new Error("body read failed") });
  const errored = await deliverWith(erroring);
  assert.equal(errored.last_error, "");
  assert.equal(errored.attempts, 1);
});

test("malformed UTF-8 is decoded deterministically in the diagnostic", async () => {
  const response = streamedResponse([new Uint8Array([0xe2, 0x28, 0xa1])]);
  const state = await deliverWith(response);

  assert.equal(state.last_error, "�(�");
});

test("fetch errors retain timeout/retry behavior", async () => {
  const { env, state } = makeEnvironment();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down / aborted");
  };
  try {
    await deliverWebhooks(env, 200, () => {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(state.status, "pending");
  assert.equal(state.attempts, 1);
  assert.match(state.last_error, /network down|aborted/);
});

test("successful responses are delivered without reading a response body", async () => {
  const response = streamedResponse([], { status: 204, keepOpen: true });
  const state = await deliverWith(response);

  assert.equal(state.status, "delivered");
  assert.equal(state.last_status, 204);
  assert.equal(response.reads, 0);
  assert.equal(response.cancelled, false);
});
