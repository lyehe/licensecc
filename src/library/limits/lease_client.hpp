#ifndef LCC_LIMITS_LEASE_CLIENT_HPP
#define LCC_LIMITS_LEASE_CLIENT_HPP

#include <cstdint>

// Reference decision logic for the lease client's renew/persist loop (design doc:
// "Client integration", phase 1). The actual HTTP and file I/O are host-specific, but
// the two load-bearing DECISIONS -- what to do given the local check + connectivity, and
// whether to durably accept a freshly fetched lease -- are pure and live here so they are
// unit-tested and shared by any host. The offline rollback check itself is
// evaluate_clock_floor() in clock_floor.hpp.

namespace license {
namespace client {

// Result of the local offline check (acquire_license + clock floor) at launch.
enum class LocalCheck {
	ValidActive,	   // signature + hw + expiry + floor all pass
	Expired,		   // now >= valid-to
	RolledBack,		   // now < clock floor (or < signed valid-from): tamper
	MissingOrCorrupt,  // no usable lease on disk
};

// Outcome of an online /v1/activate or /v1/renew attempt.
enum class RenewOutcome {
	Issued,				  // got a fresh lease
	SubscriptionInactive,  // 403: revoked / disabled / expired subscription
	Unavailable,		   // 5xx / offline / timeout
	Unauthorized,		   // 401: credential problem (distinct from subscription end)
};

// What the host should do next.
enum class LeaseAction {
	Run,			  // proceed; lease healthy
	WarnRenewSoon,	  // proceed, but surface "connect to refresh" (renew window approaching)
	RenewNow,		  // attempt online renew before/while running
	Activate,		  // no lease: attempt online activation (first run)
	RefuseExpired,	  // lease expired and cannot renew: fail closed
	RefuseTamper,	  // clock rolled back below the floor: fail closed
};

// Decide the action from the local check, connectivity, and the renew window. `now` and
// `valid_to` are epoch seconds; `warn_window_seconds` is how long before expiry to start
// warning / proactively renewing.
inline LeaseAction decide_action(LocalCheck local, bool online, uint64_t now, uint64_t valid_to,
								 uint64_t warn_window_seconds) {
	switch (local) {
		case LocalCheck::RolledBack:
			return LeaseAction::RefuseTamper;  // fail closed regardless of connectivity
		case LocalCheck::MissingOrCorrupt:
			return LeaseAction::Activate;  // host attempts activation; stays unlicensed if offline
		case LocalCheck::Expired:
			return online ? LeaseAction::RenewNow : LeaseAction::RefuseExpired;
		case LocalCheck::ValidActive: {
			const bool within_warn = valid_to >= now && (valid_to - now) <= warn_window_seconds;
			if (!within_warn) {
				return LeaseAction::Run;
			}
			// Inside the renew window: renew opportunistically when online, otherwise keep
			// running but warn -- offline tolerance is preserved up to valid-to.
			return online ? LeaseAction::RenewNow : LeaseAction::WarnRenewSoon;
		}
	}
	return LeaseAction::RefuseExpired;  // unreachable; fail closed by default
}

// Durable-write gate: accept a freshly fetched lease only if it verifies AND does not move
// the expiry backward. This stops a torn/partial write, a malformed or older 200 body, or a
// replayed earlier lease from dropping a paying user to UNLICENSED or downgrading a newer
// lease. Equal valid-to is accepted (idempotent re-fetch of the same lease).
inline bool should_replace_lease(bool new_lease_valid, bool have_current, uint64_t current_valid_to,
								 uint64_t new_valid_to) {
	if (!new_lease_valid) {
		return false;  // never overwrite a good lease with an unverifiable one
	}
	if (!have_current) {
		return true;  // first lease
	}
	return new_valid_to >= current_valid_to;  // monotonic: no downgrade
}

}  // namespace client
}  // namespace license

#endif  // LCC_LIMITS_LEASE_CLIENT_HPP
