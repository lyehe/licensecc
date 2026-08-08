#ifndef LCC_LIMITS_CLOCK_FLOOR_HPP
#define LCC_LIMITS_CLOCK_FLOOR_HPP

#include <cstdint>
#include <string>

// Persisted wall-clock high-water floor: the offline rollback protection that makes a
// lease mean anything when the user controls the clock (design doc 2026-06-21, D3).
//
// This is the wall-clock analog of the existing uint64 revocation_seq / config_seq
// floors. The host (the licensed app's renew/verify loop, see the reference client)
// owns persistence: it loads the last-seen floor, evaluates it here on every launch,
// refuses to run on a detected rollback, and persists the advanced floor. Every
// successful online renew re-anchors the floor to the server's authoritative time, so
// local tampering self-heals on next contact.
//
//   in-effect floor = max(persisted_floor, lease_valid_from)   // signed valid-from is a
//                                                              // free, unforgeable lower bound
//   run allowed     <=>  now >= in-effect floor                // else: clock rolled back
//   advanced floor  =    max(in-effect floor, now)             // monotonic; never moves down
//
// All times are epoch SECONDS, UTC. Keeping the comparison in UTC epoch seconds (rather
// than the verifier's legacy day-granularity LOCAL-midnight dates) fixes the per-timezone
// expiry drift the lease model would otherwise inherit (D5).

namespace license {
namespace limits {

struct ClockFloorDecision {
	/** False => the clock is earlier than the floor: a rollback / tamper. Fail closed. */
	bool allowed;
	/** max(persisted_floor, lease_valid_from): the bound `now` was tested against. */
	uint64_t effective_floor;
	/** The floor to persist. On allow, max(effective_floor, now); on reject, unchanged
	 *  (the floor NEVER moves down, so a rollback cannot lower it). */
	uint64_t next_floor;
};

// Evaluate the clock floor. `lease_valid_from` is 0 when the lease carries no begin
// date (then only the persisted floor applies). Pure: no clock or I/O of its own, so the
// host can drive it with a real or test-injected `now`.
inline ClockFloorDecision evaluate_clock_floor(uint64_t now, uint64_t persisted_floor, uint64_t lease_valid_from) {
	const uint64_t effective = persisted_floor > lease_valid_from ? persisted_floor : lease_valid_from;
	ClockFloorDecision decision;
	decision.effective_floor = effective;
	decision.allowed = now >= effective;
	// Advance only on an allowed check, and only upward.
	decision.next_floor = decision.allowed && now > effective ? now : effective;
	return decision;
}

// Convert a canonical YYYY-MM-DD date to the epoch second of UTC midnight that day.
// Returns false on a malformed/out-of-range date. Uses the days-from-civil algorithm
// (Howard Hinnant) so it is correct for all dates without calling mktime/gmtime (which
// are locale/timezone sensitive and not reentrant). This is the UTC-correct counterpart
// to the verifier's local-midnight date handling, used by the lease client.
inline bool utc_midnight_epoch(const std::string& yyyy_mm_dd, uint64_t& out_epoch) {
	if (yyyy_mm_dd.size() != 10 || yyyy_mm_dd[4] != '-' || yyyy_mm_dd[7] != '-') {
		return false;
	}
	for (int pos : {0, 1, 2, 3, 5, 6, 8, 9}) {
		const char ch = yyyy_mm_dd[static_cast<size_t>(pos)];
		if (ch < '0' || ch > '9') {
			return false;
		}
	}
	const int year = (yyyy_mm_dd[0] - '0') * 1000 + (yyyy_mm_dd[1] - '0') * 100 + (yyyy_mm_dd[2] - '0') * 10 +
					 (yyyy_mm_dd[3] - '0');
	const int month = (yyyy_mm_dd[5] - '0') * 10 + (yyyy_mm_dd[6] - '0');
	const int day = (yyyy_mm_dd[8] - '0') * 10 + (yyyy_mm_dd[9] - '0');
	if (year < 1970 || month < 1 || month > 12 || day < 1) {
		return false;
	}
	const bool leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
	static const int days_in_month[] = {0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
	const int month_days = (month == 2 && leap) ? 29 : days_in_month[month];
	if (day > month_days) {
		return false;
	}
	// days_from_civil: days since 1970-01-01 (UTC), Hinnant.
	const int y = (month <= 2) ? year - 1 : year;
	const int era = (y >= 0 ? y : y - 399) / 400;
	const unsigned yoe = static_cast<unsigned>(y - era * 400);
	const unsigned doy = static_cast<unsigned>((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5 + day - 1);
	const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
	const long long days = static_cast<long long>(era) * 146097 + static_cast<long long>(doe) - 719468;
	if (days < 0) {
		return false;
	}
	out_epoch = static_cast<uint64_t>(days) * 86400ULL;
	return true;
}

}  // namespace limits
}  // namespace license

#endif  // LCC_LIMITS_CLOCK_FLOOR_HPP
