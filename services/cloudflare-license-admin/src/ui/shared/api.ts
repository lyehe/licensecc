import type { ApiEnvelope } from "../../shared/api";

export interface UiApiEnvelope<T> extends ApiEnvelope<T> {
  readonly __httpOk: boolean;
  readonly __httpStatus: number;
  /** The exact parsed JSON value, including malformed null/scalar responses. */
  readonly __rawBody: unknown;
}

export interface ExactUiApiSuccess<T> {
  code: string;
  requestId: string;
  data: T;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function apiFailureDetails(value: unknown): { code: string; requestId: string } {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const envelope = value as Record<string, unknown>;
    if (nonEmptyString(envelope.code) && nonEmptyString(envelope.request_id)) {
      return { code: envelope.code, requestId: envelope.request_id };
    }
  }
  return { code: "invalid_api_response", requestId: "missing_request_id" };
}

export function apiFailureMessage(value: unknown): string {
  const { code, requestId } = apiFailureDetails(value);
  return `${code} (${requestId})`;
}

/**
 * The admin UI consumes only envelopes that prove the exact route contract.
 * A generic `ok` flag is not enough: a proxy can preserve it on a different
 * status/code, and a success without the data the screen renders is unsafe to
 * treat as a completed refresh or mutation.
 */
export function parseExactApiSuccess<T>(
  value: unknown,
  expectedCode: string,
  dataGuard: (data: unknown) => boolean,
  expectedStatus = 200,
): ExactUiApiSuccess<T> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.ok !== true || envelope.__httpOk !== true || envelope.__httpStatus !== expectedStatus ||
    envelope.code !== expectedCode || !nonEmptyString(envelope.request_id) ||
    !Object.prototype.hasOwnProperty.call(envelope, "data") || !dataGuard(envelope.data)) {
    return null;
  }
  return { code: expectedCode, requestId: envelope.request_id, data: envelope.data as T };
}

/** A successful UI response must be successful at both protocol layers. */
export function isUiApiSuccess<T>(response: UiApiEnvelope<T> | null | undefined): response is UiApiEnvelope<T> & { ok: true } {
  return response !== null && response !== undefined && response.ok === true && response.__httpOk === true;
}

/**
 * Keep transport metadata available even when JSON is not an envelope.  A
 * cursor retry policy, for example, must distinguish HTTP 503 `null` from a
 * malformed HTTP 200 response without asking callers to dereference a scalar.
 * Copy object bodies into a fresh wrapper so hostile or frozen JSON-shaped
 * values cannot make the normalization itself throw; the original parsed
 * value remains available for diagnostics.
 */
function normalizeUiApiEnvelope<T>(rawBody: unknown, httpOk: boolean, httpStatus: number): UiApiEnvelope<T> {
  const body: Record<string, unknown> = rawBody !== null && typeof rawBody === "object" && !Array.isArray(rawBody)
    ? { ...(rawBody as Record<string, unknown>) }
    : {};
  Object.defineProperties(body, {
    __httpOk: { value: httpOk, enumerable: false },
    __httpStatus: { value: httpStatus, enumerable: false },
    __rawBody: { value: rawBody, enumerable: false },
  });
  return body as unknown as UiApiEnvelope<T>;
}

export async function api<T>(path: string, init?: RequestInit): Promise<UiApiEnvelope<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    // Preserve transport loss as an invalid envelope so mutation callers can
    // retain their idempotency key instead of confusing it with a rejection.
    return normalizeUiApiEnvelope<T>(undefined, false, 0);
  }
  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch {
    rawBody = undefined;
  }
  return normalizeUiApiEnvelope<T>(rawBody, response.ok, response.status);
}
