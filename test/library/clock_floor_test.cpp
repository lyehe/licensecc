#define BOOST_TEST_MODULE test_clock_floor

#include <boost/test/unit_test.hpp>
#include <cstdint>
#include <string>

#include "../../src/library/limits/clock_floor.hpp"

// Coverage for the persisted wall-clock high-water floor (design doc D3): the offline
// rollback protection that makes a lease meaningful when the user controls the clock.

using license::limits::evaluate_clock_floor;
using license::limits::utc_midnight_epoch;

BOOST_AUTO_TEST_CASE(allows_and_advances_when_now_at_or_above_floor) {
	// now strictly above the floor advances the high-water mark to now.
	auto decision = evaluate_clock_floor(/*now=*/2000, /*persisted=*/1000, /*valid_from=*/0);
	BOOST_CHECK(decision.allowed);
	BOOST_CHECK_EQUAL(decision.effective_floor, 1000u);
	BOOST_CHECK_EQUAL(decision.next_floor, 2000u);

	// now exactly at the floor is allowed; the floor does not move.
	decision = evaluate_clock_floor(/*now=*/1000, /*persisted=*/1000, /*valid_from=*/0);
	BOOST_CHECK(decision.allowed);
	BOOST_CHECK_EQUAL(decision.next_floor, 1000u);
}

BOOST_AUTO_TEST_CASE(rejects_rollback_below_persisted_floor_without_lowering_it) {
	// Clock rolled back below the high-water mark: fail closed, floor unchanged.
	const auto decision = evaluate_clock_floor(/*now=*/500, /*persisted=*/1000, /*valid_from=*/0);
	BOOST_CHECK(!decision.allowed);
	BOOST_CHECK_EQUAL(decision.effective_floor, 1000u);
	BOOST_CHECK_EQUAL(decision.next_floor, 1000u);  // never moves down
}

BOOST_AUTO_TEST_CASE(effective_floor_is_max_of_persisted_and_valid_from) {
	// The signed valid-from is a free, unforgeable lower bound: it can raise the floor.
	auto decision = evaluate_clock_floor(/*now=*/3000, /*persisted=*/1000, /*valid_from=*/2500);
	BOOST_CHECK(decision.allowed);
	BOOST_CHECK_EQUAL(decision.effective_floor, 2500u);

	// now below the signed valid-from is a pre-issuance rollback: rejected even though it
	// is above the persisted floor.
	decision = evaluate_clock_floor(/*now=*/2000, /*persisted=*/1000, /*valid_from=*/2500);
	BOOST_CHECK(!decision.allowed);
	BOOST_CHECK_EQUAL(decision.effective_floor, 2500u);
	BOOST_CHECK_EQUAL(decision.next_floor, 2500u);
}

BOOST_AUTO_TEST_CASE(valid_from_zero_uses_only_persisted_floor) {
	const auto decision = evaluate_clock_floor(/*now=*/1500, /*persisted=*/1000, /*valid_from=*/0);
	BOOST_CHECK(decision.allowed);
	BOOST_CHECK_EQUAL(decision.effective_floor, 1000u);
	BOOST_CHECK_EQUAL(decision.next_floor, 1500u);
}

BOOST_AUTO_TEST_CASE(renew_reanchor_only_moves_floor_upward) {
	// Renew sets persisted := next_floor; a later server_time below the floor (skew) must
	// leave it unchanged.
	auto decision = evaluate_clock_floor(/*now=*/5000, /*persisted=*/1000, /*valid_from=*/0);
	BOOST_CHECK_EQUAL(decision.next_floor, 5000u);
	// Re-anchor with an earlier now: floor stays at 5000 (rejected, no downward move).
	decision = evaluate_clock_floor(/*now=*/4000, /*persisted=*/5000, /*valid_from=*/0);
	BOOST_CHECK(!decision.allowed);
	BOOST_CHECK_EQUAL(decision.next_floor, 5000u);
}

BOOST_AUTO_TEST_CASE(utc_midnight_epoch_known_vectors) {
	uint64_t epoch = 0;
	BOOST_REQUIRE(utc_midnight_epoch("1970-01-01", epoch));
	BOOST_CHECK_EQUAL(epoch, 0u);
	BOOST_REQUIRE(utc_midnight_epoch("1970-01-02", epoch));
	BOOST_CHECK_EQUAL(epoch, 86400u);
	BOOST_REQUIRE(utc_midnight_epoch("2000-01-01", epoch));
	BOOST_CHECK_EQUAL(epoch, 946684800u);
	BOOST_REQUIRE(utc_midnight_epoch("2024-01-02", epoch));
	BOOST_CHECK_EQUAL(epoch, 1704153600u);
	// Leap day exists.
	BOOST_REQUIRE(utc_midnight_epoch("2024-02-29", epoch));
	BOOST_CHECK_EQUAL(epoch, 1709164800u);
}

BOOST_AUTO_TEST_CASE(utc_midnight_epoch_rejects_malformed_and_out_of_range) {
	uint64_t epoch = 12345;
	BOOST_CHECK(!utc_midnight_epoch("2024-13-01", epoch));   // bad month
	BOOST_CHECK(!utc_midnight_epoch("2023-02-29", epoch));   // not a leap year
	BOOST_CHECK(!utc_midnight_epoch("2024-04-31", epoch));   // April has 30 days
	BOOST_CHECK(!utc_midnight_epoch("1969-12-31", epoch));   // pre-epoch rejected
	BOOST_CHECK(!utc_midnight_epoch("2024-1-1", epoch));     // wrong width
	BOOST_CHECK(!utc_midnight_epoch("2024/01/01", epoch));   // wrong separators
	BOOST_CHECK(!utc_midnight_epoch("not-a-date", epoch));
	BOOST_CHECK_EQUAL(epoch, 12345u);                        // unchanged on failure
}
