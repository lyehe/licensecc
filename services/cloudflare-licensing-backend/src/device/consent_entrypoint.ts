import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env.js";
import { boundDeviceConfig } from "./bound_config.mjs";
import { BoundRequestError, parseBoundJson } from "./bound_request.mjs";
import { inspectBoundAuthorization, approveBoundAuthorization, denyBoundAuthorization } from "./bound_consent.mjs";
import { retireBoundBinding } from "./bound_retire.mjs";

// Bind only the authenticated customer portal to this named capability.
// No public HTTP route or caller-controlled header supplies customer identity.
export class DeviceConsent extends WorkerEntrypoint<Env> {
  inspect(customerId: string, input: unknown) { return this.#execute("inspect", customerId, input); }
  approve(customerId: string, input: unknown) { return this.#execute("approve", customerId, input); }
  deny(customerId: string, input: unknown) { return this.#execute("deny", customerId, input); }

  async retire(customerId: string, input: unknown) {
    const request_id = crypto.randomUUID();
    try {
      const db = typeof this.env.DB.withSession === "function" ? this.env.DB.withSession("first-primary") : this.env.DB;
      const data = await retireBoundBinding(db, customerId, input);
      return { ok: true, status: 200, code: "binding_retired", request_id, data };
    } catch (error) {
      const known = error instanceof BoundRequestError;
      return { ok: false, status: known ? error.status : 503, code: known ? error.code : "temporarily_unavailable", request_id };
    }
  }

  async #execute(operation: "inspect" | "approve" | "deny", customerId: string, input: unknown) {
    const request_id = crypto.randomUUID();
    try {
      const fields = operation === "inspect" ? ["attempt_handle",...(input && typeof input==="object" && Object.hasOwn(input,"page_cursor")?["page_cursor"]:[])] : operation === "approve"
        ? ["attempt_handle", "entitlement_id", "expected_attempt_revision", "operation_id"]
        : ["attempt_handle", "expected_attempt_revision", "operation_id"];
      if (!input || typeof input !== "object" || Array.isArray(input)
          || Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field))) throw new BoundRequestError();
      const values = input as Record<string, unknown>;
      for (const field of fields) {
        const value = values[field];
        if (field === "expected_attempt_revision") {
          if (!Number.isSafeInteger(value) || Object.is(value,-0) || (value as number) < 0 || (value as number) >= Number.MAX_SAFE_INTEGER) throw new BoundRequestError();
        } else if (typeof value !== "string" || value.length > (field==="page_cursor"?512:16384)) throw new BoundRequestError();
      }
      const encoded = JSON.stringify(input);
      if (!encoded || encoded.length > 16384) throw new BoundRequestError();
      const body = parseBoundJson(new TextEncoder().encode(encoded));
      const config = boundDeviceConfig(this.env);
      const db = typeof this.env.DB.withSession === "function" ? this.env.DB.withSession("first-primary") : this.env.DB;
      let data;
      if (operation === "inspect") {
        data = await inspectBoundAuthorization(db, customerId, body.attempt_handle, config, body.page_cursor);
      } else if (operation === "approve") {
        data = await approveBoundAuthorization(db, customerId, body, config, this.env.BOUND_APPROVAL_ENCRYPTION_KEYS);
      } else {
        data = await denyBoundAuthorization(db, customerId, body, config);
      }
      return { ok: true, status: 200, code: operation === "inspect" ? "authorization_inspected" : operation === "approve" ? "authorization_approved" : "authorization_denied", request_id, data };
    } catch (error) {
      const known = error instanceof BoundRequestError;
      return { ok: false, status: known ? error.status : 503, code: known ? error.code : "temporarily_unavailable", request_id };
    }
  }
}
