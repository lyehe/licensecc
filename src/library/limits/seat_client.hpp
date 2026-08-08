#ifndef LCC_LIMITS_SEAT_CLIENT_HPP
#define LCC_LIMITS_SEAT_CLIENT_HPP

#include <cstdint>

// Reference decision logic for the FLOATING (concurrent-seat) client. Floating is
// online-required and is the opposite of the offline lease (lease_client.hpp): the server
// is the live source of truth for who holds a seat, the client holds a short-TTL lccoa1
// seat token (verified by the existing C++ online_verification), and must heartbeat to keep
// it. A held seat is valid until its expiry regardless of connectivity (the grace window);
// once it lapses, floating offers no offline run unless the seat was BORROWED.
//
// HTTP/file I/O is host-specific; the two pure decisions live here so they are unit-tested.

namespace license {
namespace client {

// State of the locally-held seat token relative to now.
enum class SeatToken {
	ValidHeld,	 // token valid, comfortably before expiry
	NearExpiry,	 // token valid but inside the heartbeat window: refresh soon
	Expired,	 // token expired: the seat has (almost certainly) been reclaimed
	None,		 // no seat held
};

// Outcome of the most recent /v1/checkout or /v1/heartbeat call (None before any call).
enum class SeatServerResult {
	None,
	Granted,		// checkout/heartbeat succeeded
	PoolExhausted,	// 409: no free seat in the pool
	Reclaimed,		// 410: our seat lapsed and was reclaimed (heartbeat too late)
	Inactive,		// 403: entitlement not active
	Unavailable,	// 5xx / offline / timeout
};

// What the host should do next.
enum class SeatAction {
	Run,				   // hold a valid seat; nothing to do
	HeartbeatNow,		   // refresh the seat before it expires
	Checkout,			   // acquire a seat (first run / lost seat)
	RefusePoolExhausted,   // pool is full; cannot run right now
	RefuseNoSeat,		   // online-required and we have no live seat (and cannot get one)
};

// Classify the held seat token. `heartbeat_window` is how long before expiry to start
// refreshing. Epoch seconds.
inline SeatToken classify_seat_token(bool have_token, uint64_t now, uint64_t expires_at, uint64_t heartbeat_window) {
	if (!have_token) {
		return SeatToken::None;
	}
	if (now >= expires_at) {
		return SeatToken::Expired;
	}
	if (expires_at - now <= heartbeat_window) {
		return SeatToken::NearExpiry;
	}
	return SeatToken::ValidHeld;
}

// Decide the next action. A hard server verdict from the last call takes precedence over the
// local token state.
inline SeatAction decide_seat_action(SeatToken token, bool online, SeatServerResult last) {
	if (last == SeatServerResult::PoolExhausted) {
		return SeatAction::RefusePoolExhausted;
	}
	if (last == SeatServerResult::Inactive) {
		return SeatAction::RefuseNoSeat;
	}
	if (last == SeatServerResult::Reclaimed) {
		// Our seat is gone; reacquire if we can, otherwise we cannot run.
		return online ? SeatAction::Checkout : SeatAction::RefuseNoSeat;
	}
	switch (token) {
		case SeatToken::ValidHeld:
			return SeatAction::Run;
		case SeatToken::NearExpiry:
			// Refresh when online; otherwise keep running on the still-valid token until it
			// actually expires (offline tolerance is bounded by the grace window).
			return online ? SeatAction::HeartbeatNow : SeatAction::Run;
		case SeatToken::Expired:
		case SeatToken::None:
			// Floating is online-required: no live seat means checkout, or refuse if offline.
			return online ? SeatAction::Checkout : SeatAction::RefuseNoSeat;
	}
	return SeatAction::RefuseNoSeat;  // unreachable; fail closed
}

}  // namespace client
}  // namespace license

#endif  // LCC_LIMITS_SEAT_CLIENT_HPP
