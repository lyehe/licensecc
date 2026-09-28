# Delete a customer account

**This is a manual operator runbook, not an API.** Neither the customer portal
nor the admin console deletes an account. An operator with access to the
production D1 database runs these steps after a verified deletion request.
Customers can disconnect Google or GitHub from Account in the portal
themselves; that removes one sign-in method, not the account.

The procedure disables the customer, clears the personal data the platform
stores for them, and keeps the records that audit and license enforcement
depend on. It keeps the `customers` row and its ID. D1 enforces foreign keys,
so deleting that row fails while protected devices, a provider identity or a
password still reference it. Once those are gone, the delete would cascade into
the `customer_events` and `portal_bootstrap_events` audit rows.

## Before you start

- Find the customer ID (for example `cust_…`) in the admin console under
  Customers.
- Use a ticket number as every reason, never the customer's name or email
  address. Reasons are kept in audit rows.
- Keep a list of the customer IDs you have deleted, and nothing else about
  them. You need it after a database restore; see the last section.

## What the runbook clears and keeps

The steps below change these records.

| Record | Action |
| --- | --- |
| `customers.name`, `email`, `metadata_json`, `external_ref` | The row and its ID stay. The fields become `Deleted customer`, empty, `{}` and empty. `external_ref` is the customer's ID in your commerce system; clearing it drops that link. |
| `portal_passwords` | Deleted: the login email and password hash. |
| `portal_identities` | Deleted: the Google or GitHub subject and email. |
| `portal_otp` | Deleted: email codes and the address they went to. |
| `portal_password_actions` | Deleted: this customer's reset links, and registration links sent to its addresses. |
| `portal_sessions` | Deleted: browser sessions and their user agents. |
| `rate_limit_counters` keyed `request:email:<address>` | Deleted: the address in plain text. These counters expire within 30 minutes anyway. |
| `mutation_idempotency` entries whose cached response is this customer | Deleted: the admin console's create and disable responses copy the name and email addresses. |
| `device_bound_devices.label`, `device_bound_authorizations.device_label` | Emptied: device names reported by the customer's apps, which often contain a person's name. |
| `account_tokens` | Revoked, with an audit row. |

Registration links and `request:email:` counters are found through the
customer's contact and login addresses only, not through the email addresses of
its Google or GitHub identities. Any others expire on their own (links after 15
minutes, counters within 30 minutes), and later requests sweep them.

These records are kept on purpose. Some of them still contain personal data,
which stays until your own retention policy removes it.

| Record | Why it stays | Personal data it can still contain |
| --- | --- | --- |
| `entitlement_events` | License audit trail. `audit_digests` hash-chains it, so editing a row breaks `GET /api/admin/audit/verify`. | `actor`; for portal device releases, the customer's IP address in `ip`. |
| `customer_events` | Admin audit of disable and re-enable. | Whatever an operator typed as `reason`. |
| `portal_bootstrap_events` | Audit of operator break-glass sign-in codes. | The address the code was issued for (`email_lower`). |
| `order_events` | Order ingest journal and order webhook source. | `raw_payload` is the order exactly as your commerce system sent it, which can include the name and email. |
| `account_token_events`, `policy_events`, `catalog_events`, `license_plan_assignment_events`, `webhook_events` | Admin audit. | Operator text only. |
| `device_bound_devices`, `device_bound_bindings`, `device_bound_events`, `device_bound_operations` | Protected-device enforcement history. Triggers forbid deleting devices, bindings and operations. | None after the labels are cleared. |
| `entitlements`, `licenses`, `orders`, `license_plan_assignments`, `entitlement_devices`, `account_tokens` | License records and revoked tokens, keyed by the customer ID. | Only what an operator wrote into a note or label: `entitlements.notes`, `licenses.label`, `licenses.metadata_json`, `entitlement_devices.notes`, and `account_tokens.name`. The token name is the CLI's `--name`; the `issue` row in `account_token_events` also keeps it as its `reason`, and that audit copy stays. If one names the person, clear it. Clear entitlement notes in the admin console's entitlement editor, which records the change, and the others with a reviewed SQL `UPDATE`. The trigger `tr_bound_reject_legacy_device_update` aborts an `UPDATE` of an `entitlement_devices` row whose entitlement is `device_bound_v1`, so limit that one to legacy entitlements. |

## 1. Disable the customer and revoke their tokens

1. In the admin console, open the customer under Customers and choose
   **Disable**, with a ticket number as the reason. The customer then shows as
   suspended. Disabling ends their license and token access and their portal
   access at once, records a `customer_events` row, and does not notify them.
2. Revoke the customer's account tokens, so that re-enabling the customer by
   mistake cannot bring them back. From `services/cloudflare-licensing-backend`,
   with the Wrangler configuration that binds the production database:

   ```console
   node scripts/account-token.mjs revoke-customer --customer-id <customer-id> --reason "TICKET-123" --actor you@example.com --database <database-name> --remote
   ```

   This writes one `revoke-customer` row to `account_token_events`.

Decide separately what happens to the customer's licenses. This runbook does
not revoke or reassign entitlements.

## 2. Clear the personal data

Save the SQL below as `customer-deletion.sql` and replace every
`REPLACE_WITH_CUSTOMER_ID` with the customer ID. If the ID contains a single
quote, write it as two. Every statement acts only on a customer that is already
disabled, so the file changes nothing while the customer is still active or if
the ID is wrong. Review the file, then run it from
`services/cloudflare-licensing-backend`.

Rehearse first with `--local` in place of `--remote`, using the same Wrangler
configuration. The local copy needs the migrations
(`npx wrangler d1 migrations apply <database-name> --local`) and a restored
export or a few seeded rows. Check the result with the query in step 3, then
run it for real:

```console
npx wrangler d1 execute <database-name> --remote --file customer-deletion.sql
```

D1 runs the file as one transaction: either every statement applies, or none
does.

```sql
-- Delete a customer account: a manual operator runbook, not an API.
-- Password links: this customer's reset links, and registration links sent to its addresses.
WITH target AS (SELECT id, lower(email) AS email FROM customers WHERE id = 'REPLACE_WITH_CUSTOMER_ID' AND status = 'disabled')
DELETE FROM portal_password_actions
WHERE customer_id IN (SELECT id FROM target)
   OR (purpose = 'register' AND email_lower IN (
        SELECT email FROM target WHERE email <> ''
        UNION SELECT email_lower FROM portal_passwords WHERE customer_id IN (SELECT id FROM target)));

-- Email-code request counters keyed by the address.
WITH target AS (SELECT id, lower(email) AS email FROM customers WHERE id = 'REPLACE_WITH_CUSTOMER_ID' AND status = 'disabled')
DELETE FROM rate_limit_counters
WHERE namespace = 'portal' AND rate_key IN (
  SELECT 'request:email:' || email FROM target WHERE email <> ''
  UNION SELECT 'request:email:' || email_lower FROM portal_passwords WHERE customer_id IN (SELECT id FROM target));

-- Sign-in methods and sign-in state.
WITH target AS (SELECT id FROM customers WHERE id = 'REPLACE_WITH_CUSTOMER_ID' AND status = 'disabled')
DELETE FROM portal_passwords WHERE customer_id IN (SELECT id FROM target);
WITH target AS (SELECT id FROM customers WHERE id = 'REPLACE_WITH_CUSTOMER_ID' AND status = 'disabled')
DELETE FROM portal_identities WHERE customer_id IN (SELECT id FROM target);
WITH target AS (SELECT id FROM customers WHERE id = 'REPLACE_WITH_CUSTOMER_ID' AND status = 'disabled')
DELETE FROM portal_otp WHERE customer_id IN (SELECT id FROM target);
WITH target AS (SELECT id FROM customers WHERE id = 'REPLACE_WITH_CUSTOMER_ID' AND status = 'disabled')
DELETE FROM portal_sessions WHERE customer_id IN (SELECT id FROM target);

-- Admin console replay-cache entries that copied the customer (create and disable responses).
WITH target AS (SELECT id FROM customers WHERE id = 'REPLACE_WITH_CUSTOMER_ID' AND status = 'disabled')
DELETE FROM mutation_idempotency
WHERE scope LIKE 'POST:/api/admin/customers%'
  AND (CASE WHEN json_valid(response_json) THEN json_extract(response_json, '$.data.id') END) IN (SELECT id FROM target);

-- Device names reported by the customer's apps.
WITH target AS (SELECT id FROM customers WHERE id = 'REPLACE_WITH_CUSTOMER_ID' AND status = 'disabled')
UPDATE device_bound_devices SET label = '' WHERE customer_id IN (SELECT id FROM target);
WITH target AS (SELECT id FROM customers WHERE id = 'REPLACE_WITH_CUSTOMER_ID' AND status = 'disabled')
UPDATE device_bound_authorizations SET device_label = '' WHERE customer_id IN (SELECT id FROM target);

-- The customer row keeps its ID. This runs last because the statements above read its email.
UPDATE customers
SET name = 'Deleted customer', email = '', metadata_json = '{}', external_ref = '', updated_at = unixepoch()
WHERE id = 'REPLACE_WITH_CUSTOMER_ID' AND status = 'disabled';
```

## 3. Check the result

```console
npx wrangler d1 execute <database-name> --remote --command "SELECT name, email, metadata_json, external_ref, status, (SELECT count(*) FROM portal_passwords WHERE customer_id = c.id) + (SELECT count(*) FROM portal_identities WHERE customer_id = c.id) + (SELECT count(*) FROM portal_otp WHERE customer_id = c.id) + (SELECT count(*) FROM portal_sessions WHERE customer_id = c.id) + (SELECT count(*) FROM portal_password_actions WHERE customer_id = c.id) AS sign_in_rows FROM customers c WHERE id = '<customer-id>'"
```

Expect `Deleted customer`, an empty email, `{}`, an empty `external_ref`,
`disabled`, and `0` sign-in rows. If the name is unchanged, the customer was not
disabled when the file ran; finish step 1 and run the file again.

## Backups and other copies

The steps above clear the live database only.

- **D1 Time Travel** can restore any minute of the last 30 days on Workers Paid
  (7 days on Workers Free); see
  [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).
- **R2 SQL exports** from the `cloudflare-d1-backup` Worker keep full copies of
  every row until retention pruning (`BACKUP_RETENTION_DAYS`) deletes them.

Both keep the customer's personal data until they age out. Restoring either one
brings the data back. After any restore, run this runbook again for every
customer ID on your deletion list.

Outside D1, your email provider keeps its own logs of the messages it delivered
to the customer; use its tools and retention settings. Google and GitHub keep
their record that the customer authorized your portal. The portal never stores
provider tokens, and the customer can remove that authorization in their
Google or GitHub account settings.
