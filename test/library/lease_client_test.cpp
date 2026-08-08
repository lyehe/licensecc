#define BOOST_TEST_MODULE test_lease_client

#include <boost/test/unit_test.hpp>
#include <cstdint>

#include "../../src/library/limits/lease_client.hpp"

// Coverage for the lease client's renew/persist decision logic: the state machine that
// must never lock out a paying user or fail open, and the durable-write gate that must
// never let a torn/older/invalid lease downgrade or drop a good one.

using license::client::decide_action;
using license::client::LeaseAction;
using license::client::LocalCheck;
using license::client::should_replace_lease;

namespace {
constexpr uint64_t kNow = 1'000'000;
constexpr uint64_t kWarn = 7 * 86400;  // warn within 7 days of expiry
}  // namespace

BOOST_AUTO_TEST_CASE(rollback_fails_closed_regardless_of_connectivity) {
	BOOST_CHECK(decide_action(LocalCheck::RolledBack, true, kNow, kNow + 1000, kWarn) == LeaseAction::RefuseTamper);
	BOOST_CHECK(decide_action(LocalCheck::RolledBack, false, kNow, kNow + 1000, kWarn) == LeaseAction::RefuseTamper);
}

BOOST_AUTO_TEST_CASE(missing_lease_drives_activation) {
	BOOST_CHECK(decide_action(LocalCheck::MissingOrCorrupt, true, kNow, 0, kWarn) == LeaseAction::Activate);
	// Offline first run still returns Activate; the host attempts it and stays unlicensed if it fails.
	BOOST_CHECK(decide_action(LocalCheck::MissingOrCorrupt, false, kNow, 0, kWarn) == LeaseAction::Activate);
}

BOOST_AUTO_TEST_CASE(expired_renews_when_online_else_fails_closed) {
	BOOST_CHECK(decide_action(LocalCheck::Expired, true, kNow, kNow - 1, kWarn) == LeaseAction::RenewNow);
	BOOST_CHECK(decide_action(LocalCheck::Expired, false, kNow, kNow - 1, kWarn) == LeaseAction::RefuseExpired);
}

BOOST_AUTO_TEST_CASE(healthy_lease_runs_and_warns_in_the_renew_window) {
	// Far from expiry: just run.
	BOOST_CHECK(decide_action(LocalCheck::ValidActive, true, kNow, kNow + 30 * 86400, kWarn) == LeaseAction::Run);
	BOOST_CHECK(decide_action(LocalCheck::ValidActive, false, kNow, kNow + 30 * 86400, kWarn) == LeaseAction::Run);

	// Inside the warn window: renew when online, warn-but-run when offline (offline tolerance
	// preserved up to valid-to).
	BOOST_CHECK(decide_action(LocalCheck::ValidActive, true, kNow, kNow + 3 * 86400, kWarn) == LeaseAction::RenewNow);
	BOOST_CHECK(decide_action(LocalCheck::ValidActive, false, kNow, kNow + 3 * 86400, kWarn) ==
				LeaseAction::WarnRenewSoon);
}

BOOST_AUTO_TEST_CASE(durable_write_rejects_invalid_and_downgrades) {
	// Never overwrite a good lease with an unverifiable one.
	BOOST_CHECK(!should_replace_lease(/*new_valid=*/false, /*have_current=*/true, /*cur=*/2000, /*new=*/3000));
	// First lease is always accepted.
	BOOST_CHECK(should_replace_lease(true, /*have_current=*/false, 0, 1000));
	// Later or equal expiry is accepted (monotonic; equal = idempotent re-fetch).
	BOOST_CHECK(should_replace_lease(true, true, 2000, 3000));
	BOOST_CHECK(should_replace_lease(true, true, 2000, 2000));
	// Earlier expiry (torn/older/replayed body) is rejected -- no downgrade.
	BOOST_CHECK(!should_replace_lease(true, true, 2000, 1999));
}
