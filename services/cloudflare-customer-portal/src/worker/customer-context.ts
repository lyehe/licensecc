import { envelope } from "./support.js";

// A precondition on the account the caller displayed, never an authority source.
// Cookie authentication still selects the customer for every read and write.
export function customerContextError(expected: string | null, customerId: string): "invalid_request" | "account_changed" | null {
  if (!expected) return "invalid_request";
  return expected === encodeURIComponent(customerId) ? null : "account_changed";
}

export function requireCustomerContext(request: Request, customerId: string, reqId: string): Response | null {
  const error = customerContextError(request.headers.get("x-expected-customer-id"), customerId);
  return error ? envelope(reqId, error, undefined, error === "account_changed" ? 409 : 400, { "cache-control": "no-store" }) : null;
}
