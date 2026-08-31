# Observability and alert verification

This runbook defines the operational half of production-readiness gate
`PRD-05`. It is a specification for protected staging and production; it does
not create a monitoring account, notification destination, deployment, or
secret. Those remain Cloudflare/operator-owned resources.

## Telemetry contract

Every protected Wrangler configuration must enable persisted observability,
invocation logs, query-string redaction, and a non-zero head sample. The
deployment materializer rejects a configuration that does not. Use a sampling rate of `1` through the
pilot and capacity windows; a later reduction requires a reviewed decision
that preserves enough data for every alert below.

Protected dry-run, deployment, migration, and deployment-list commands run
through a fixed-operation wrapper. It captures bounded Wrangler stdout/stderr,
suppresses raw diagnostics, and emits only redacted status or deployment
identity fields. Deployment transition evidence is separately polled until a
new sole 100% active version is visible or the bounded poll fails. This protects
workflow artifacts; it does not replace the sensitive-value review of the
provider's retained invocation and application logs.

The licensing backend emits one-line JSON application events. The logger adds
`event` and `severity`, admits only its bounded operational field allow-list,
replaces control characters, and drops unknown fields. In particular, it does
not admit raw IP addresses, fingerprints, device hashes or key IDs, customer or
license identifiers, email addresses, request/response bodies, assertions,
tokens, OTPs, signing material, payloads, or arbitrary exception messages.
The portal emits one closed-shape
`portal.email_delivery_failed` error event when delivery is unconfigured,
throws/fails, is rejected, or returns an invalid result. Its only varying field
is `error_type` from `unconfigured`, `send_failed`, `rejected`, or
`invalid_result`; it never includes the recipient, OTP/magic secret, API key,
provider text, or exception message, and the HTTP response retains the
anti-enumeration contract. The backup Worker emits `backup.unhandled_error`
with an exception type only. Other non-backend outcomes rely on invocation
metrics and their bounded validation outputs.

The monitoring destination may be Cloudflare-native or an approved exported
log/metric system, but it must preserve these dimensions without ingesting
request bodies or authorization headers:

- environment and exact Worker/service identity;
- deployed Worker version and release commit association;
- UTC event timestamp, status code, route template, and duration;
- structured `event`, `severity`, and admitted operational fields; and
- latest validated backup manifest identity, `snapshot_requested_at`, R2 upload
  time, streamed integrity result, and explicit authenticity disposition.

Do not use a raw URL containing a query string as a route dimension. Do not
turn customer, fingerprint, device, email, token-prefix, or IP values into
labels. High-cardinality customer data is both a privacy risk and a poor alert
key.

## Required dashboards

Create one staging dashboard and one production dashboard from the same
reviewed definition. Each dashboard must show the selected UTC window and the
deployed version beside the measurements.

| Panel | Required measurement |
| --- | --- |
| Public verifier traffic | requests/second, concurrency when available, status family, recognized allow/deny/rate-limit classification, and availability |
| Public verifier latency | p50, p95, and p99 duration with separate D1 duration from `verify.ok` and `verify.denied` |
| Backend failures | counts by `event` for every error-severity event and `verify.request_proof` result |
| Abuse controls | `verify.rate_limited` by limiter source and malformed-request counts, without source identity |
| Downstream delivery | pending/delivered/failed webhook counts, `webhook.*` warning/error events, and `portal.email_delivery_failed` counts by its four-value `error_type` |
| Configuration | `/health` readiness, invalid mode names, and the count of consistency warnings |
| Backup/recovery | last completed snapshot time, R2 upload time, backup age from `snapshot_requested_at`, Workflow result, SHA-256/size and object/manifest agreement, snapshot-count inventory status, historical migration/schema identity, migration-upgrade result, final schema digest, authenticity disposition, last scratch restore time, and measured RPO/RTO |
| Four-Worker health | request/error/duration summaries for backend, admin, portal, and backup, split by environment |

Capacity evidence from `capacity:public-verifier` is overlaid on the same UTC
window. The overlay must name the approved backend deployment ID, sole active
version UUID, exact commit, and whether that target remained unchanged before
and after the run. The load harness result is not a substitute for retained
service telemetry and makes no account-token or lease-signing claim.

## Alert policy

The monitoring system must evaluate the following predicates continuously.
`Page` means a human-acknowledged urgent destination; `warn` means the staffed
operational queue. Missing data fails closed for health and backup predicates.

| ID | Predicate | Warn | Page / release effect |
| --- | --- | --- | --- |
| OBS-01 | public verifier unexpected 5xx or transport-failure ratio | at least 0.05% for 10 minutes; at low traffic, two failures in 10 minutes | at least 0.1% for 5 minutes, or any `verify.unhandled_error`, `verify.d1_error`, `verify.signing_error`, or `lease.signing_error`; page and block promotion |
| OBS-02 | public verifier latency | p95 at least 400 ms or p99 at least 800 ms for 10 minutes | p95 at least 500 ms or p99 at least 1 second for 5 minutes; page and block promotion |
| OBS-03 | latest completed, identity-valid, integrity-valid, and snapshot-inventory-valid backup age measured from `snapshot_requested_at` | 45 minutes | 60 minutes, missing/invalid manifest, failed Workflow, SQL/manifest digest or size mismatch, snapshot-count mismatch, noncanonical/incomplete migration upgrade, or invalid final schema identity; page and block migrations/promotion |
| OBS-04 | security configuration consistency | any non-empty `/health` warning or readiness probe failure | invalid security mode, disabled required enforcement, or warning lasting 5 minutes; page and block traffic promotion |
| OBS-05 | webhook delivery | `webhook.signing_unconfigured`, `webhook.signing_key_missing`, `webhook.sign_failed`, `webhook.enqueue_error`, or `webhook.deliver_error` once | `webhook.delivery_failed` once or any enqueue/deliver error for 5 minutes; page and retain the failed delivery for controlled redrive |
| OBS-06 | emergency/security anomaly | abnormal request-proof failure or rate-limit growth versus the preceding 24-hour staging/production baseline | any `account.emergency_override_used`; page immediately and open an incident record |
| OBS-07 | portal transactional email | any `portal.email_delivery_failed`, grouped only by its bounded `error_type` | any occurrence in production or a sustained staging occurrence for 5 minutes; page/block promotion until delivery is restored and separately proven end to end |

The backup Worker is scheduled every 30 minutes. That cadence creates room for
export completion while the manifest freshness check enforces the one-hour RPO
from the time immediately before export; a recent R2 upload cannot refresh an
old snapshot. The schedule alone is never accepted as freshness evidence.

## Staging alert drill

Run the drill against the exact release commit after the four-Worker staging
deployment and before a production approval. Never weaken or pause a production
control to manufacture an alert.

1. Record the commit, deployed versions, dashboard/query revision, UTC start,
   receivers, and accountable operator. Use the notification provider's test
   function to prove the receiver route; label that result as transport-only.
2. Exercise OBS-01 in an isolated staging/canary dependency fault or replay one
   synthetic error event through the exact production alert query. Show the
   predicate changing state and the receiver acknowledging it. A hand-written
   screenshot or transport-only test is insufficient.
3. Evaluate OBS-03 against a controlled stale manifest fixture through the same
   freshness probe. Do not stop real backups. Prove both the 45-minute warning
   and 60-minute page boundaries, then prove recovery when a fresh, identity-
   valid manifest is selected.
4. Exercise OBS-04 with a canary health response containing a configuration
   warning and an invalid-mode readiness failure. The protected materializer
   must continue rejecting such a configuration for the real staging services.
5. Configure a synthetic staging webhook receiver to return a bounded `503`,
   generate a synthetic event, allow the documented retries to reach
   `webhook.delivery_failed`, acknowledge the alert, restore the receiver, and
   use the controlled redrive path. Remove the synthetic endpoint afterward.
6. Route one synthetic portal sign-in through a canary email sender that
   returns the bounded rejected result. Prove exactly one redacted
   `portal.email_delivery_failed` event reaches OBS-07, acknowledge and clear
   the alert, and restore the sender. This exercises failure telemetry only;
   it is not evidence that a real transactional email was delivered.
7. Confirm every alert clears, no production resource was selected, and no
   customer payload or credential appears in the retained evidence.

If the monitoring product cannot replay a predicate safely, use a separately
named staging canary Worker/source that feeds the identical query and routing
pipeline. Record the difference as a limitation; do not claim that a receiver
test alone exercised the predicate.

## Sensitive-value review

For the capacity window and each alert drill, review both application and
invocation logs. Search for the following classes without copying any match
into a committed report:

- authorization/cookie values, `lcca_` tokens, OTPs, and email addresses;
- PEM headers, long base64/key material, and webhook or signing secrets;
- complete 64-hex fingerprints/device hashes/key IDs;
- `lccoa1` assertions, license payloads, request/response bodies, and customer
  or license identifiers; and
- raw client IP addresses or URLs containing userinfo, query, or fragment.

The review passes only with zero unexplained matches. A false positive records
the query category and disposition, not the matched value. Any real sensitive
value is an incident: restrict the affected log store, rotate exposed
credentials when applicable, fix the producer, and repeat the full review.

## Evidence and verification

Retain the detailed redacted evidence bundle outside source control in the
restricted archive, then commit only its redacted attestation summary under
`docs/implementation/` using the production-readiness evidence format. The
summary binds protected object/run identifiers and SHA-256 digests without
copying the underlying logs or configuration. Move required workflow artifacts
to that archive before their 30-day expiry and retain them for at least 12
months after the final go/no-go decision, or longer when incident/audit policy
requires. The bundle and summary must contain or reference:

- immutable workflow/run and dashboard/query references;
- exact commit and four deployed version identities;
- alert ID, predicate revision, trigger/notification/acknowledgement/clear UTC
  timestamps, receiver class, and outcome;
- capacity p50/p95/p99, availability, unexpected-error ratio, declared `P`,
  offered rate, achieved rate, request totals, approved backend
  deployment/version/commit, and before/after target stability;
- selected manifest identity, snapshot and upload timestamps, streamed and
  downloaded SHA-256/size agreement, R2 metadata, manifest-pinned count result,
  historical migration/schema identity, migration suffix result, final schema
  digest/counts, `authenticity_verified` disposition, backup age, Workflow
  status, restore elapsed time, and RPO/RTO result; and
- log-review window, sampled event count, search categories, match count, and
  reviewer disposition.

Do not retain raw logs, notification payloads, configuration, customer data,
email addresses, or secret values in the repository. Absent dashboards,
unrouted alerts, unexercised predicates, non-zero sensitive matches, stale
backups, or a shortened capacity run are explicit `blocked`/`failed` results,
not partial passes.
