import type { ConfirmActionFailure } from "./operatorActions";
import type { FeedbackDetail, OperatorFeedback } from "./operatorFeedback";

/*
 * The operator's sentence for every result code the console can meet: the admin Worker's envelope
 * codes and the codes the console raises itself (validation and local checks). A code and its
 * request id never become the main text; they travel as the feedback's `detail`, which
 * FeedbackText shows under "Technical details". Wording follows doc/architecture/glossary.md.
 */

export type FeedbackTone = OperatorFeedback["tone"];

export interface CodeCopy {
  readonly text: string;
  readonly tone: FeedbackTone;
}

const failed = (text: string): CodeCopy => ({ text, tone: "error" });
const done = (text: string): CodeCopy => ({ text, tone: "success" });

// "Refresh" re-reads the data on screen; "Reload the page" is kept for the few codes where the page
// itself built a request the server could not accept (its key, body or origin).
const REFRESH_AND_RETRY = "Refresh and try again.";

/** A write whose outcome is unknown: it is retained, and only reconciling it may settle it. */
export const OUTCOME_UNKNOWN_TEXT = "The outcome of this change is unknown. Don't repeat it; reconcile its status first.";
/** A write known to have applied whose status read then failed. */
export const STATUS_NOT_REFRESHED_TEXT = "The change was applied, but its status could not be refreshed.";
const RELOAD_AND_RETRY = "Reload the page and try again.";

export const RESULT_CODE_COPY: Readonly<Record<string, CodeCopy>> = {
  // Sign-in and request handling, shared by every route.
  admin_auth_not_configured: failed("Admin sign-in is not configured for this console. Ask an administrator to set it up."),
  admin_role_denied: failed("Your account does not have access to the admin console."),
  admin_role_required: failed("Only administrators can do this."),
  missing_access_jwt: failed("Your sign-in is missing or has expired. Sign in again."),
  invalid_access_jwt: failed("Your sign-in could not be verified. Sign in again."),
  dev_bearer_forbidden_in_environment: failed("Developer sign-in is not allowed in this environment."),
  sync_auth_not_configured: failed("Entitlement sync is not configured for this console."),
  invalid_sync_token: failed("The sync token was not accepted."),
  cross_site_mutation_forbidden: failed(`The request did not come from this console, so it was blocked. ${RELOAD_AND_RETRY}`),
  not_found: failed(`That record was not found; it may have been removed. ${REFRESH_AND_RETRY}`),
  invalid_request: failed("The request was not accepted. Check the values and try again."),
  invalid_json: failed(`The request could not be read. ${RELOAD_AND_RETRY}`),
  body_too_large: failed("The request is too large. Shorten the values and try again."),
  invalid_idempotency_key: failed(`The request key was not accepted. ${RELOAD_AND_RETRY}`),
  idempotency_key_required: failed(`The request key is missing. ${RELOAD_AND_RETRY}`),
  idempotency_request_conflict: failed(`This request key was already used for a different change. ${RELOAD_AND_RETRY}`),
  idempotency_conflict: failed(`This request was already sent with different details. ${REFRESH_AND_RETRY}`),
  mutation_failed: failed("The change could not be saved. Try again."),
  reason_required: failed("Enter a reason."),
  rate_limited: failed("Too many requests. Wait a moment and try again."),
  temporarily_unavailable: failed("The service is temporarily unavailable. Try again shortly."),
  audit_verify_failed: failed("The audit history could not be checked. Try again."),

  // Licenses (entitlements), their device limit and activated devices.
  entitlement_saved: done("License (entitlement) created."),
  entitlement_patched: done("Entitlement changes saved."),
  entitlement_disabled: done("Entitlement suspended."),
  entitlement_reenabled: done("Entitlement is active again."),
  entitlement_revoked: done("Entitlement revoked."),
  entitlement_synced: done("Entitlement synced."),
  entitlement_batch_too_large: failed("Too many entitlements for one request. Select fewer and try again."),
  batch_done: done("Batch finished."),
  // Emitted for an entitlement and for an activated device, so it names neither.
  stale_transition: failed(`This record changed after you loaded it. ${REFRESH_AND_RETRY}`),
  revoked_entitlement_is_terminal: failed("Revocation is permanent; this license (entitlement) can no longer change."),
  invalid_entitlement_id: failed("That entitlement ID is not valid."),
  enforcement_mode_conflict: failed("A license (entitlement) for this project, feature and fingerprint already uses a different protection."),
  protected_creation_conflict: failed("This protected license (entitlement) can't be created with these settings."),
  policy_stamping_disabled: failed("Creating a license (entitlement) from a policy is turned off for this console."),
  capacity_in_use: failed("More devices are connected than this device limit allows; disconnect one first."),
  seats_released: done("Seats released."),
  device_disabled: done("Activated device suspended."),
  device_reenabled: done("Activated device is active again."),
  device_revoked: done("Activated device revoked."),
  device_not_found: failed(`That activated device was not found. ${REFRESH_AND_RETRY}`),
  device_is_terminal: failed("This activated device is revoked and can no longer change."),
  invalid_device_key_id: failed("That device ID is not valid."),

  // Customers, their licenses and connections.
  customer_created: done("Customer account created."),
  customer_disabled: done("Customer suspended."),
  customer_reenabled: done("Customer is active again."),
  customer_inactive: failed("The customer is suspended; reenable the customer first."),
  customer_status_conflict: failed(`The customer's status changed. ${REFRESH_AND_RETRY}`),
  email_in_use: failed("This email already belongs to an account."),
  license_created: done("License created."),
  binding_retired: done("Connection disconnected. Its slot is released after the hold period."),
  binding_unavailable: failed("That connection is no longer available. Refresh the connections."),
  access_denied: failed("You don't have access to this customer's connections."),
  revision_conflict: failed("The connection changed since you reviewed it. Refresh and review it again."),
  operator_changed: failed("Your sign-in changed since you reviewed this. Refresh and review it again."),

  // Policies.
  policy_created: done("Policy created."),
  policy_patched: done("Policy changes saved."),
  // Also a refusal: a catalog row or plan names a disabled policy. The sentence reads either way.
  policy_disabled: done("The policy is disabled."),
  policy_reenabled: done("Policy is active again."),
  policy_name_conflict: failed("A policy with this name already exists in this project. Choose another name."),
  policy_not_found: failed("That policy was not found. Choose another policy."),
  policy_status_conflict: failed(`The policy's status changed. ${REFRESH_AND_RETRY}`),

  // Webhooks.
  webhook_created: done("Webhook endpoint created."),
  webhook_patched: done("Webhook endpoint changes saved."),
  webhook_disabled: done("Webhook endpoint disabled."),
  webhook_reenabled: done("Webhook endpoint is active again."),
  webhook_delivery_redriven: done("Delivery queued for another attempt."),
  webhook_delivery_not_failed: failed("Only a failed delivery can be retried."),
  webhook_status_conflict: failed(`The endpoint's status changed. ${REFRESH_AND_RETRY}`),
  webhook_test_sent: done("Test event sent."),
  webhook_operator_not_configured: failed("Sending test events is not set up for this admin console yet."),
  webhook_signing_unconfigured: failed("Webhook signing is not configured on the licensing backend."),
  invalid_url: failed("Enter one https:// address on a public host name (no IP addresses, credentials, or internal names like localhost or .internal)."),
  invalid_event_types: failed("One or more event types aren't recognized. Choose from the listed event types."),

  // Plans, features and catalog import.
  catalog_feature_created: done("Feature created."),
  catalog_feature_patched: done("Feature changes saved."),
  catalog_feature_disabled: done("Feature disabled."),
  catalog_feature_reenabled: done("Feature is active again."),
  catalog_feature_conflict: failed("A feature with this key already exists in this project."),
  catalog_feature_not_found: failed("That feature is not in the catalog. Choose a feature from the list."),
  catalog_plan_created: done("Plan created."),
  catalog_plan_patched: done("Plan changes saved."),
  catalog_plan_disabled: done("Plan disabled."),
  catalog_plan_reenabled: done("Plan is active again."),
  catalog_plan_conflict: failed("A plan with this key and version already exists in this project."),
  catalog_plan_not_found: failed(`That plan was not found. ${REFRESH_AND_RETRY}`),
  catalog_plan_feature_saved: done("Plan feature saved."),
  catalog_plan_feature_disabled: done("Plan feature disabled."),
  catalog_plan_feature_reenabled: done("Plan feature is active again."),
  catalog_plan_feature_conflict: failed("This plan already has a row with this feature or add-on key."),
  catalog_plan_feature_not_found: failed(`That plan feature was not found. ${REFRESH_AND_RETRY}`),
  catalog_status_conflict: failed(`The catalog record's status changed. ${REFRESH_AND_RETRY}`),
  catalog_mutation_failed: failed("The catalog change could not be saved. Try again."),
  catalog_import_previewed: done("Import preview ready. Review it before you apply it."),
  catalog_import_applied: done("Catalog import applied."),
  catalog_import_snapshot_stale: failed("The catalog changed after this preview. Preview the import again."),
  stale_catalog_import_preview: failed("This import preview is out of date. Preview the import again."),
  expired_catalog_import_preview: failed("This import preview expired. Preview the import again."),
  claimed_catalog_import_preview: failed("This import preview was already used. Preview the import again."),
  catalog_import_too_large: failed("This import is too large to apply at once. Narrow the manifest and preview it again."),
  preview_required: failed("Preview first, then apply the reviewed result."),
  // Emitted for a plan feature whose project differs from its plan's, and for a policy of another project.
  invalid_plan_config: failed("A plan feature's project or policy doesn't match the plan's project. Fix the plan's features and try again."),
  unknown_addon: failed("One of the add-ons is not offered by this plan."),
  plan_not_found: failed("That plan was not found. Check the plan key or plan ID."),
  plan_disabled: failed("That plan is disabled. Reenable it or choose another plan."),
  plan_projection_blocked: failed("A revoked license (entitlement) blocks this plan. Preview again to review it."),
  plan_projection_failed: failed("The plan could not be applied. Try again."),
  plan_projection_too_large: failed("This plan would change too many licenses (entitlements) at once."),
  stale_projection_preview: failed("The license or catalog changed after this preview. Preview again before you apply."),
  projection_preview_grant_expired: failed("This preview expired. Preview again before you apply."),
  license_fingerprint_conflict: failed("This license fingerprint conflicts with existing access. Preview again before you apply."),
  license_plan_projection_previewed: done("Plan preview ready. Review it before you apply it."),
  license_plan_projection_applied: done("Plan applied."),

  // Raised by the console itself.
  action_failed: failed("The action could not be completed. Try again."),
  status_refresh_failed: failed("The status could not be refreshed. Try again."),
  invalid_api_response: failed("The server's response could not be read. Check your connection and try again."),
  invalid_mutation_response: failed("The server's response to this change could not be read. Refresh to see its result."),
  invalid_target_identity: failed("The refreshed record did not match the one you changed. Refresh the list."),
  duplicate_page_item: failed("The next page repeated records already shown. Refresh the list."),
  repeated_cursor: failed("The list returned the same page again. Refresh the list."),
  mutation_busy: failed("Another action is still running. Wait for it to finish and try again."),
  csv_export_failed: failed("The CSV export failed. Try again."),
  invalid_form: failed("Check the highlighted values and try again."),
  customer_not_selected: failed("Select a customer first."),
  device_entitlement_not_selected: failed("Open an entitlement's devices first."),
  no_entitlements_selected: failed("Select at least one entitlement."),
  policy_not_available: failed("The chosen policy is no longer available. Choose an active policy."),
  catalog_policy_not_available: failed("The chosen policy is no longer active. Choose an active policy."),
  catalog_feature_not_visible: failed("That feature is no longer in the current list. Refresh and open it again."),
  catalog_plan_not_visible: failed("That plan is no longer in the current list. Refresh and open it again."),
  catalog_plan_required: failed("Choose a plan from the current list first."),
  invalid_catalog_import_manifest: failed("The manifest is not valid JSON."),
  catalog_import_manifest_digest_mismatch: failed("The server's preview did not match this manifest. Preview it again."),
  catalog_import_preview_id_required_or_invalid: failed("This import preview can't be applied. Preview the import again."),
  plan_projection_preview_required: failed("This plan preview is no longer current. Preview again before you apply."),
  preview_id_required_or_invalid: failed("This plan preview can't be applied. Preview again before you apply."),
  plan_projection_digest_failed: failed("The plan preview could not be prepared in this browser. Try again."),
  addon_key_required: failed("Enter an add-on key."),
  plan_id_or_plan_key_required: failed("Enter a plan key or a plan ID."),
  license_id_required: failed("Enter a license ID."),
  invalid_date: failed("Enter a valid date."),
  notes_must_be_at_most_1000_chars: failed("Use one line of at most 1000 characters."),
  floating_pool_size_must_be_at_least_1: failed("A floating policy needs a pool of at least 1 seat."),
  node_locked_pool_size_must_be_0: failed("A device-locked policy has no seat pool; set the pool size to 0."),
  url_must_be_a_single_https_url: failed("Enter a single https:// URL without spaces."),
  url_must_be_https: failed("The URL must start with https://."),
  description_invalid: failed("Use one line of at most 500 characters."),
  scope_set_project_or_customer_not_both: failed("Set a project scope or a customer scope, not both."),
  event_types_invalid: failed("The event type list is too long or contains a line break."),
  event_types_token_has_whitespace: failed("An event type can't contain spaces."),
};

/** Validation codes that share one shape: the field's name (the first group), then the rule it broke. */
const FAMILY_COPY: ReadonlyArray<readonly [RegExp, (match: RegExpMatchArray) => CodeCopy]> = [
  [/^([a-z][a-z0-9_]*)_must_be_between_(-?\d+)_and_(-?\d+)$/, (match) => failed(`Enter a whole number from ${Number(match[2]).toLocaleString("en-US")} to ${Number(match[3]).toLocaleString("en-US")}.`)],
  [/^([a-z][a-z0-9_]*)_must_be_a_valid_date$/, () => failed("Enter a valid date on or after January 1, 1970.")],
  [/^([a-z][a-z0-9_]*)_must_be_at_most_128_chars$/, () => failed("Use at most 128 characters, on one line.")],
  [/^([a-z][a-z0-9_]*)_must_be_a_single_value$/, () => failed("Enter one value of at most 128 characters, without commas or line breaks.")],
  [/^([a-z][a-z0-9_]*)_required_or_too_long$/, () => failed("Required. Use one line within the length limit.")],
  [/^([a-z][a-z0-9_]*)_too_long_or_invalid$/, () => failed("Use one line within the length limit.")],
];

function familyMatch(code: string): readonly [RegExpMatchArray, (match: RegExpMatchArray) => CodeCopy] | null {
  for (const [pattern, build] of FAMILY_COPY) {
    const match = code.match(pattern);
    if (match !== null) return [match, build];
  }
  return null;
}

/** The copy for a code, or null for one the console has no sentence for. Prototype keys never match. */
export function describeCode(code: string): CodeCopy | null {
  if (Object.hasOwn(RESULT_CODE_COPY, code)) return RESULT_CODE_COPY[code];
  const family = familyMatch(code);
  return family === null ? null : family[1](family[0]);
}

/** The field a family validation code names (`duration_sec` for `duration_sec_must_be_…`), or null. */
export function ruleCodeField(code: string): string | null {
  return Object.hasOwn(RESULT_CODE_COPY, code) ? null : familyMatch(code)?.[0][1] ?? null;
}

/** An unrecognized code still gives the operator a reference to quote, and never a dangling one. */
export function unknownResultText(requestId: string | null): string {
  return requestId === null || requestId.trim() === "" ? "Something went wrong. Try again." : `Something went wrong. Reference ${requestId}.`;
}

function detailFor(code: string, requestId: string | null): FeedbackDetail {
  return { code, requestId: requestId === null || requestId.trim() === "" ? null : requestId };
}

/** Feedback for a result code: its sentence and tone, with the code and request id as detail. */
export function codeFeedback(code: string, requestId: string | null = null): OperatorFeedback {
  const known = describeCode(code);
  return { tone: known?.tone ?? "error", message: known?.text ?? unknownResultText(requestId), detail: detailFor(code, requestId) };
}

/** A code the request was refused with: always an error, whatever the code's usual tone. */
export function failureFeedback(code: string, requestId: string | null = null): OperatorFeedback {
  return { ...codeFeedback(code, requestId), tone: "error" };
}

/** A workflow's own sentence for a code, keeping the code and request id as detail. */
export function feedbackWith(message: string, code: string, requestId: string | null = null, tone: FeedbackTone = "error"): OperatorFeedback {
  return { tone, message, detail: detailFor(code, requestId) };
}

/**
 * Feedback for a response that was not the expected success, including a malformed or lost one. A
 * success envelope that failed its checks is unreadable: its own success code never reads as the
 * failure, though its request id still identifies the response.
 */
export function apiFailureFeedback(value: unknown): OperatorFeedback {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const { ok, code, request_id: requestId } = value as Record<string, unknown>;
    const reference = typeof requestId === "string" ? requestId : null;
    if (ok === true) return failureFeedback("invalid_api_response", reference);
    if (typeof code === "string" && code.trim() !== "") return failureFeedback(code, reference);
  }
  return failureFeedback("invalid_api_response");
}

/** A confirmation or consequence refused by the server: the dialog or notice shows why. */
export function refusalOutcome(code: string, requestId: string | null): ConfirmActionFailure {
  const { message, detail } = failureFeedback(code, requestId);
  return { ok: false, message, detail, retryable: true };
}

/** The code a validator threw, or the generic form code for anything else. */
export function validationCode(error: unknown): string {
  return error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : "invalid_form";
}
