#define BOOST_TEST_MODULE test_seat_client

#include <boost/test/unit_test.hpp>
#include <cstdint>

#include "../../src/library/limits/seat_client.hpp"

// Coverage for the floating (concurrent-seat) client decision logic: online-required,
// heartbeat-driven, distinct from the offline lease client. It must run on a valid seat,
// refresh before expiry, reacquire a lost seat, and fail closed when there is no live seat
// or the pool is full.

using license::client::classify_seat_token;
using license::client::decide_seat_action;
using license::client::SeatAction;
using license::client::SeatServerResult;
using license::client::SeatToken;

namespace {
constexpr uint64_t kNow = 1'000'000;
constexpr uint64_t kHeartbeatWindow = 300;  // refresh within 5 min of expiry
}  // namespace

BOOST_AUTO_TEST_CASE(classify_seat_token_states) {
	BOOST_CHECK(classify_seat_token(false, kNow, kNow + 1000, kHeartbeatWindow) == SeatToken::None);
	BOOST_CHECK(classify_seat_token(true, kNow, kNow, kHeartbeatWindow) == SeatToken::Expired);
	BOOST_CHECK(classify_seat_token(true, kNow, kNow - 1, kHeartbeatWindow) == SeatToken::Expired);
	BOOST_CHECK(classify_seat_token(true, kNow, kNow + 200, kHeartbeatWindow) == SeatToken::NearExpiry);
	BOOST_CHECK(classify_seat_token(true, kNow, kNow + kHeartbeatWindow, kHeartbeatWindow) == SeatToken::NearExpiry);
	BOOST_CHECK(classify_seat_token(true, kNow, kNow + 1000, kHeartbeatWindow) == SeatToken::ValidHeld);
}

BOOST_AUTO_TEST_CASE(valid_seat_runs) {
	BOOST_CHECK(decide_seat_action(SeatToken::ValidHeld, true, SeatServerResult::Granted) == SeatAction::Run);
	BOOST_CHECK(decide_seat_action(SeatToken::ValidHeld, false, SeatServerResult::None) == SeatAction::Run);
}

BOOST_AUTO_TEST_CASE(near_expiry_refreshes_online_runs_offline) {
	BOOST_CHECK(decide_seat_action(SeatToken::NearExpiry, true, SeatServerResult::None) == SeatAction::HeartbeatNow);
	// Offline within the grace window: keep running on the still-valid token until it expires.
	BOOST_CHECK(decide_seat_action(SeatToken::NearExpiry, false, SeatServerResult::None) == SeatAction::Run);
}

BOOST_AUTO_TEST_CASE(no_live_seat_checks_out_online_else_refuses) {
	BOOST_CHECK(decide_seat_action(SeatToken::None, true, SeatServerResult::None) == SeatAction::Checkout);
	BOOST_CHECK(decide_seat_action(SeatToken::Expired, true, SeatServerResult::None) == SeatAction::Checkout);
	// Floating is online-required: no seat + offline => cannot run.
	BOOST_CHECK(decide_seat_action(SeatToken::None, false, SeatServerResult::None) == SeatAction::RefuseNoSeat);
	BOOST_CHECK(decide_seat_action(SeatToken::Expired, false, SeatServerResult::None) == SeatAction::RefuseNoSeat);
}

BOOST_AUTO_TEST_CASE(server_verdicts_take_precedence) {
	BOOST_CHECK(decide_seat_action(SeatToken::None, true, SeatServerResult::PoolExhausted) ==
				SeatAction::RefusePoolExhausted);
	BOOST_CHECK(decide_seat_action(SeatToken::None, true, SeatServerResult::Inactive) == SeatAction::RefuseNoSeat);
	// Reclaimed (410 on heartbeat): the seat is gone; reacquire if online, else refuse.
	BOOST_CHECK(decide_seat_action(SeatToken::Expired, true, SeatServerResult::Reclaimed) == SeatAction::Checkout);
	BOOST_CHECK(decide_seat_action(SeatToken::Expired, false, SeatServerResult::Reclaimed) == SeatAction::RefuseNoSeat);
}
