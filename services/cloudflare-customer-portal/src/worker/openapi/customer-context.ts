export const CUSTOMER_CONTEXT_PARAMETER = {
  name: "x-expected-customer-id", in: "header", required: true,
  schema: { type: "string", minLength: 1 },
  description: "encodeURIComponent of the customer ID displayed by the caller. Required before account reads or changes. Compared with the authenticated session, never used as authority. A mismatch returns account_changed (409) without reading or changing the other account; refresh /api/portal/me and ask for a new action.",
};
