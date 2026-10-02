# Live defects and open items: evidence

This report covers two rounds of fixes to defects that were live on `main` and
sat in code the customer, license and device workflow redesign
(`docs/superpowers/specs/2026-10-01-customer-license-device-workflow-design.md`)
keeps. Items in code that the redesign deletes or rewrites were left alone on
purpose; the spec lists them.

Each change was written test-first: a failing commit, marked `(RED)`, comes
before its fix. Every lane was reviewed independently, then reviewed again
after each fix round.

## Round one (merged at `370e6b09`)

These fixes landed on 2026-10-01 in `34bb0d47..370e6b09`.

**Portal sign-in**

- A wrong email code now counts against the live code, and the code stops
  working after five wrong checks. Counting and claiming happen in one
  statement, so the cap also holds under concurrent checks.
- Each email address has its own verify budget, and per-client limits group
  IPv6 clients by /64.
- Linking Google or GitHub requires a sign-in from the last ten minutes.

**Orders**

- An order whose email already belongs to another customer is refused with the
  terminal code `409 customer_email_conflict`. Withdrawals still apply.
- An order that would lower the device limit below the number of connected
  devices is refused with the terminal code `409 capacity_in_use`.
- Order activity in the admin console says, in words, why an order was refused.

**Operator CLI and device labels**

- The emergency entitlement CLI refuses unknown customers, suspended customers
  and grants owned by another customer. It can no longer reactivate a revoked
  grant.
- A device label can no longer imitate the comparison code. The rule refuses
  control, format and separator characters, folds fullwidth characters and
  treats dashes and spaces as separators before it looks for the code. The
  backend owns the rule, and the native client reads a table generated from it.

`npm run check:pr` passed on merged `main` (1,723 passed). The same tree had
also passed:

- the e2e suites: 8, 195 and 132;
- the documentation build and the deploy dry run;
- native CTest: 32/32 on dev-debug and 57/57 on device-identity, with build
  purity;
- the Python SDK (163 passed) and the .NET SDK (33 passed).

## Round two (this report)

### Device protocol

**Renewal challenges**

- A renewal challenge is now issued for any existing binding. Before the device
  proves its key, the response no longer reveals license or account state.
  After proof, each state still gets its existing refusal.
- A disconnected or disabled device gets `device_retired` before any license
  check, both on renewal and on a replayed exchange. Retirement can therefore
  never reveal the license state.
- The native client's public result is unchanged, and a test pins that.

**Device labels**

- Labels are compared by their Unicode UTS #39 confusable skeleton, limited to
  the code alphabet. Each label is folded to its skeleton:
  - single-character confusables, such as Cyrillic `А` and the mathematical
    digits;
  - O, I and l as stand-ins for 0 and 1;
  - prototypes of several characters, such as `Ⅱ`, `Ꝏ` and `⒋`;
  - characters that look like a dash, which count as separators.
- A label is refused when its skeleton contains a code shape.
- The data is a subset of the pinned Unicode 17.0.0 `confusables.txt`
  (SHA-256 `091c7f82…`). The subset itself is pinned by a separate digest,
  validated as sorted, unique and disjoint, and carries the Unicode License v3
  notice in `doc/other/CREDITS.md`.
- The backend and the generated native table agree on every code point in nine
  contexts.

### Native, offline and SDKs

- **3072-bit golden vectors.** The v201 golden vectors are signed with a
  3072-bit key by `scripts/generate-v201-golden-vectors.mjs`, which a drift
  check covers. The runtime already enforced the 3072-bit floor. The Python,
  .NET and Java config-token verifiers now pin it too.
- **OpenSSL key decoding.**
  - The verifier decodes keys through `OSSL_DECODER`, after an exact PKCS#1
    shape check. The shape check is needed because OpenSSL 3 also accepts SPKI
    and non-minimal DER. With the check in place, OpenSSL refuses exactly what
    CNG refuses.
  - The runtime builds with `OPENSSL_API_COMPAT=30000` and
    `OPENSSL_NO_DEPRECATED`. That surfaced one deprecated macro in the TPM2
    provider, which was moved.
- **Config verify options.** `LCC_CONFIG_VERIFY_OPTIONS_VERSION` is now 1,
  matching the other unreleased option structures.
- **CMake components.** `find_package(licensecc ... REQUIRED COMPONENTS <unknown>)`
  now fails and lists the available components.
- **`lccgen` output.** The help documents `YYYY-MM-DD` dates. After writing a
  license, `lccgen` prints the path and a summary line.
- **Example label.** The device-bound example labels each device with its
  computer name and falls back to "Computer". A configure-time label still
  overrides both.
- **Tests and CI.**
  - Every SDK pins a token under another envelope prefix.
  - The public-API linkage test no longer makes a tautological pointer
    comparison.
  - CI no longer installs `zlib1g-dev`, which nothing links.
  - CI also tests the example with a configured UTF-8 label.
  - The static build-purity contract now runs in `test:native-security`.
  - The unused 1024-bit generator fixture is removed.

### Backend, webhooks and tooling

**Webhook deliveries**

- A PATCH that changes a webhook endpoint's URL or scope cancels its queued
  deliveries in the same batch.
- The dispatcher re-checks scope before sending.
- Redrive refuses a canceled delivery, including when it loses a race against
  the cancellation.
- A delivery already in flight when the endpoint changes keeps its acknowledged
  outcome.
- The admin console says why a delivery was canceled.
- The dispatcher's `reason` log field is kept, but only for values from its
  closed set.

**Portal and tooling**

- The portal's email code lookup has a partial index:
  `idx_portal_otp_email_live`. The restore drill was re-pinned once: 64
  indexes, signature `6c825b21…`.
- `order-sign.mjs` reads its HMAC secret from `ORDER_SIGNING_SECRET_B64` or
  `--secret-file`, never from argv. It reports a refused option without echoing
  the option's value, and it no longer waits on a terminal.
- Wrangler is now 4.146.0 in all four Workers and the release assembly, and
  `brace-expansion` is 1.1.21. `npm audit` reports 0 vulnerabilities.

### Documentation

- The consent URL is `/connect` throughout: the examples, the CI config sample
  and the SDK mocks. A guard test keeps `/authorize` out.
- The glossary names `device_limit_reached`, and the stale consent sentence is
  rewritten.
- The TPM negative README guard is restored, and a guard was added for a quoted
  `'Released'` state.
- One credit link that redirected now points to its destination.
- `npm run check:docs:links` found no broken links.

## Gates

The integration branch combines all four lanes and the spec amendments.

The integration branch is `370e6b09..d611b11c`. The gates ran at two points:

- `ac628080` was the integration head before a test-only fix. The fix made the
  v201 vector drift test handle a checkout that is already CRLF. Every gate in
  the first table ran there except `check:pr`, which failed only on that drift
  test. Nothing else in those gates reads the drift test, so the results carry
  over.
- `d611b11c` is the final head.

| Command | Commit | Outcome |
| --- | --- | --- |
| `npm run test:e2e` | `ac628080` | backend 8/8, admin 196 passed, portal 132 passed |
| `npm run check:docs` | `ac628080` | exit 0 |
| `npm run check:dry-run` | `ac628080` | exit 0 |
| `npm run test:docs-quickstart` | `ac628080` | exit 0 |
| `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug` | `ac628080` | exit 0 |
| `ctest --preset dev-debug` | `ac628080` | 34/34 |
| `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset ci-windows-device-identity-test` | `ac628080` | exit 0 |
| `ctest --preset ci-windows-device-identity-test` | `ac628080` | 59/59 |
| `uv run --directory sdks/python --locked pytest` | `ac628080` | 167 passed, 2 skipped |
| `dotnet test Licensecc.Client.sln` (scratch copy, see below) | `ac628080` | 37 passed, 4 skipped |

| Command | Commit | Outcome |
| --- | --- | --- |
| `npm run check:pr` | `d611b11c` | exit 0, 1,795 passed, 0 failed |
| WSL `cmake --preset ci-linux-debug -G Ninja`, build, `ctest --preset ci-linux-debug` | `d611b11c` | configure 0, build 0, no warnings outside the vendored generator; 29/34 |
| Java SDK in WSL (OpenJDK 17), the `scripts/test-java-sdk.mjs` javac/jar/java sequence | `d611b11c` | "Java SDK tests passed" |

How some of these were run:

- **WSL failures.** The five WSL failures are known environment failures:
  `test_project`, `test_file_publish`, `test_os_linux`, `test_dmi_info` and
  `test_execution_environment`.
- **.NET.** `global.json` pins SDK 8.0.423 and this host has 8.0.425, so the
  .NET suite ran from a scratch copy with `rollForward: latestFeature` and the
  repository's `test/vectors`.
- **Java.** Java ran in WSL because there is no Windows JDK. Its JNI fixture
  checks report themselves skipped.
- **Lane gates.** Each lane also ran its own gates before integration. Those
  results are not repeated here.
- **Link check.** `npm run check:docs:links` ran in the documentation lane and
  found no broken links.

## Accepted residuals

Each of these was judged and accepted. It is either outside a claim the docs
make, or of the same kind and size as residuals already accepted.

- Lowercase `o` standing in for 0 is accepted in device labels, because its
  UTS #39 skeleton is `o`. The comparison code is uppercase, so the difference
  shows.
- `_`, `.` and `/` are not separators. The box-drawing `│` reads as a separator,
  because the vertical em dash's prototype is `│`.
- A disabled device that gets a fresh customer approval and exchanges a new
  code still has its license checked first. Exploiting this needs a fresh
  approval and a state change inside the code's 60-second lifetime. It predates
  these fixes and lies outside the renewal and replay claim in TM-04.
- A webhook cancellation is recorded as the delivery row's status and reason,
  not as a separate event.
- An order for a subscription whose email conflicted is still refused after
  that first conflict. There is no account-merge tool; the redesign removes
  the case.
- The vendored generator keeps its own deprecated OpenSSL calls. Only the
  runtime verifier was in scope.
- Linux builds of the device-bound example run in CI, because they need a TPM2
  package that this host does not have.

## Not run

- Live Cloudflare deploys, the staging drill and `remote-d1-atomicity`. These
  need credentials.
- Live TPM, browser and backend release gates. These need hardware.
