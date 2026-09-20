-- Lease history is not the slot ledger. A binding retains its maximum hold
-- independently, and exact-response recovery reads the operation record.
CREATE INDEX idx_bound_lease_cleanup ON device_bound_leases(accept_until);
