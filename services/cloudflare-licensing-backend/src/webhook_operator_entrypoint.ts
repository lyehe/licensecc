import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env.js";
import { sendWebhookTestEvent } from "./webhooks/test_event.mjs";

// Bind only the authenticated admin Worker. This capability sends one signed test event to an
// active endpoint's stored https URL and reports only the receiver's status class. It cannot
// change an endpoint or a delivery, and it never returns the signing secret, the signature or
// anything from the receiver's response.
export class WebhookOperator extends WorkerEntrypoint<Env> {
  async sendTest(endpointId: unknown) {
    const request_id = crypto.randomUUID();
    const db = typeof this.env.DB.withSession === "function" ? this.env.DB.withSession("first-primary") : this.env.DB;
    const result = await sendWebhookTestEvent({ ...this.env, DB: db }, endpointId);
    return { ...result, request_id };
  }
}
