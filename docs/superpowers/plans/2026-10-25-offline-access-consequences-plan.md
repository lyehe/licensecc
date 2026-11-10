# Offline access consequence plan

Baseline: `c5b1b268f82704e2f6d5d651cba8c7adf37e60b0` on
`fix/ui-ux-gap-closure-20261025`.

Objective: close the confirmed offline-consequence wording gaps using the
[design specification](../specs/2026-10-25-offline-access-consequences-design.md).
This plan is frozen when implementation begins. Record completed work and
validation under `docs/implementation/` rather than modifying this plan.

## 1 Confirm the behavior and preserve ownership

- Read the architecture index, change guide, ownership map and ADR 0006.
- Verify signed-expiry, restart, denial and slot-hold behavior against the
  existing domain/backend/native sources. Preserve their implementation.
- Classify the checkout and own only the new specification, plan, affected
  UI copy/tests, glossary, service README updates and implementation report.
- Keep local artifacts under
  `build/offline-consequences-20261025-c5b1b268/`.

## 2 Correct the consequence messages consistently

- Add a small admin-local offline consequence constant used by customer
  suspension, grant suspension/revocation and device disconnection.
- Consolidate single/bulk grant consequence wording in the grant workflow
  owner, preserving target identity, permanence and already-revoked handling.
- Update the portal disconnect dialog with offline expiry, online restart
  and slot-release meaning. Keep the displayed release timestamp authoritative.
- Update the glossary and both service READMEs with the accepted semantics.
- Do not change policy durations, APIs, schema, native behavior, permissions,
  idempotency, reason gating, typed confirmations or notification behavior.

## 3 Verify presentation and the existing safeguards

- Update affected existing checks for the corrected consequence text.
- Use existing browser scenarios to inspect the confirmations at desktop
  and mobile widths and retain screenshots. Verify cancellation still sends
  no request, reasons and typed confirmation still gate actions, and each
  confirmed operation retains its original request identity.
- Keep the additions focused on the real consequence workflows; no new
  test harness or copy-only snapshot suite is needed.
- Refresh maintained source measurements from the final candidate.

## 4 Run integration gates and record closure

Use pinned npm `10.9.8`, uv `0.12.18` and Python `3.12` for the deterministic
gate. Run the root commands:

```powershell
npm ci
npm run check:pr
npm run setup:browsers
npm run test:e2e
npm run check:dry-run
npm run check:docs
```

The native install, SDK and core-purity gates are outside this UI-only scope.
Record exact commands, outcomes, verified ref, relevant surfaces not run,
candidate/build correspondence and remaining external validation in an
implementation report. Commit only owned source/docs/tests and retain a
clean worktree. No deployment or production-data change is part of this task.
