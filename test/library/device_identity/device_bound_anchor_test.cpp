#define BOOST_TEST_MODULE device_bound_anchor_test
#include <boost/property_tree/json_parser.hpp>
#include <boost/test/unit_test.hpp>
#include "bound_anchor.hpp"
#include "bound_encoding.hpp"
#include <algorithm>
#include <fstream>
#include <limits>
#include <type_traits>

using namespace license::device_identity;
namespace {
constexpr std::uint64_t second = 10000000;
class FakePlatform final : public BoundAnchorPlatform {
public:
	BoundClockSample clock{100 * second, 90 * second, 90 * second, 1};
	bool random_ok = true, clock_ok = true;
	unsigned calls = 0, jump_call = 0;
	std::uint64_t jump_ticks = 0;
	std::uint8_t random_byte = 11;
	bool random_operation(std::array<std::uint8_t, 32>& out) noexcept override {
		out.fill(random_byte);
		return random_ok;
	}
	bool sample(BoundClockSample& out) noexcept override {
		if (++calls == jump_call) advance(jump_ticks);
		out = clock;
		// Successive brackets must be ordered, including the second reading
		// after cryptographic work. Preserve the same bias interval.
		advance(clock.awake_after - std::min(clock.awake_before, clock.awake_after));
		return clock_ok;
	}
	void advance(std::uint64_t ticks) {
		clock.inclusive += ticks;
		clock.awake_before += ticks;
		clock.awake_after += ticks;
	}
};
struct Fixture {
	std::string token;
	BoundLeaseExpected expected;
	std::vector<BoundLeaseTrustKey> keys;
	Fixture() {
		std::ifstream stream(std::string(LCC_DEVICE_IDENTITY_VECTOR_ROOT) + "/device_bound/v1/protocol.json");
		BOOST_REQUIRE(stream.good());
		boost::property_tree::ptree v;
		boost::property_tree::read_json(stream, v);
		token = v.get<std::string>("token");
		ParsedBoundLease parsed;
		BOOST_REQUIRE(decode_bound_lease(token, parsed));
		const auto& c = parsed.claims;
		expected = {c.issuer,	  c.audience,	   c.project,	   c.feature,	 c.license_fingerprint,
					c.binding_id, c.device_key_id, c.operation_id, c.generation, c.revocation_seq};
		std::vector<std::uint8_t> spki;
		BOOST_REQUIRE(bound_encoding::decode_base64url(v.get<std::string>("lease_signer_spki"), 1024, spki));
		keys.push_back({spki, false});
	}
};
}  // namespace

BOOST_AUTO_TEST_CASE(effective_time_ceil_and_overflow_preserve_output) {
	std::uint64_t out = 17;
	BOOST_REQUIRE(bound_effective_time(100, 50, 50, out));
	BOOST_CHECK_EQUAL(out, 100);
	BOOST_REQUIRE(bound_effective_time(100, 50, 51, out));
	BOOST_CHECK_EQUAL(out, 101);
	BOOST_REQUIRE(bound_effective_time(100, 50, 50 + second, out));
	BOOST_CHECK_EQUAL(out, 101);
	BOOST_REQUIRE(bound_effective_time(100, 50, 51 + second, out));
	BOOST_CHECK_EQUAL(out, 102);
	BOOST_CHECK(!bound_effective_time(100, 50, 49, out));
	BOOST_CHECK(!bound_effective_time(9007199254740991ULL, 0, 1, out));
	BOOST_CHECK(!bound_effective_time(9007199254740992ULL, 0, 0, out));
	BOOST_CHECK_EQUAL(out, 102);
}

BOOST_AUTO_TEST_CASE(retries_keep_original_send_and_expire_including_response_delay) {
	Fixture f;
	auto platform = std::make_unique<FakePlatform>();
	auto* clock = platform.get();
	auto anchor = BoundLeaseAnchor::create(std::move(platform));
	BOOST_REQUIRE(anchor);
	BOOST_CHECK_EQUAL(anchor->operation_id(), f.expected.operation_id);
	BoundLeaseClaims out;
	clock->advance(40000 * second);
	BOOST_REQUIRE(anchor->verify(f.token, f.keys, f.expected, out));
	clock->advance(46399 * second);
	BOOST_REQUIRE(anchor->verify(f.token, f.keys, f.expected, out));
	clock->advance(1);	// ceil makes the signed expiry exclusive.
	out.lease_id = "unchanged";
	BOOST_CHECK(!anchor->verify(f.token, f.keys, f.expected, out));
	BOOST_CHECK_EQUAL(out.lease_id, "unchanged");
	BOOST_CHECK_EQUAL(anchor->operation_id(), f.expected.operation_id);
}

BOOST_AUTO_TEST_CASE(verification_work_and_lost_continuity_cannot_extend_acceptance) {
	Fixture f;
	for (int fault = 0; fault < 6; ++fault) {
		auto platform = std::make_unique<FakePlatform>();
		auto* clock = platform.get();
		auto anchor = BoundLeaseAnchor::create(std::move(platform));
		BOOST_REQUIRE(anchor);
		BoundLeaseClaims out;
		out.lease_id = "unchanged";
		const auto good = clock->clock;
		if (fault == 0) clock->clock.inclusive += second;  // suspend bias changed
		if (fault == 1) clock->clock.process_id = 2;
		if (fault == 2) clock->clock.inclusive--;
		if (fault == 3) clock->clock.awake_after += 100001;	 // uncertain sample bracket
		if (fault == 4) clock->clock.awake_before = clock->clock.awake_after + 1;
		if (fault == 5) clock->clock_ok = false;
		BOOST_CHECK(!anchor->verify(f.token, f.keys, f.expected, out));
		clock->clock = good;
		clock->clock_ok = true;
		BOOST_CHECK(!anchor->verify(f.token, f.keys, f.expected, out));	 // loss is sticky
		BOOST_CHECK_EQUAL(out.lease_id, "unchanged");
	}
	auto platform = std::make_unique<FakePlatform>();
	auto* clock = platform.get();
	auto anchor = BoundLeaseAnchor::create(std::move(platform));
	BOOST_REQUIRE(anchor);
	clock->jump_call = 3;
	clock->jump_ticks = 86400 * second;	 // expires during verification
	BoundLeaseClaims out;
	out.lease_id = "unchanged";
	BOOST_CHECK(!anchor->verify(f.token, f.keys, f.expected, out));
	BOOST_CHECK_EQUAL(out.lease_id, "unchanged");
}

BOOST_AUTO_TEST_CASE(fresh_operation_rejects_cached_response_and_failed_creation) {
	static_assert(!std::is_copy_constructible<BoundLeaseAnchor>::value, "anchors cannot be copied");
	static_assert(!std::is_move_constructible<BoundLeaseAnchor>::value, "anchors cannot be transferred");
	Fixture f;
	auto platform = std::make_unique<FakePlatform>();
	platform->random_byte = 12;
	auto anchor = BoundLeaseAnchor::create(std::move(platform));
	BOOST_REQUIRE(anchor);
	BoundLeaseClaims out;
	BOOST_CHECK(!anchor->verify(f.token, f.keys, f.expected, out));
	f.expected.operation_id = anchor->operation_id();
	BOOST_CHECK(!anchor->verify(f.token, f.keys, f.expected, out));
	BOOST_CHECK(!BoundLeaseAnchor::create(nullptr));
	platform = std::make_unique<FakePlatform>();
	platform->random_ok = false;
	BOOST_CHECK(!BoundLeaseAnchor::create(std::move(platform)));
	platform = std::make_unique<FakePlatform>();
	platform->clock.inclusive = std::numeric_limits<std::uint64_t>::max();
	BOOST_CHECK(!BoundLeaseAnchor::create(std::move(platform)));
}

BOOST_AUTO_TEST_CASE(platform_factory_uses_windows_clocks_or_fails_closed) {
#if defined(_WIN32)
	auto one = BoundLeaseAnchor::create(make_bound_anchor_platform());
	auto two = BoundLeaseAnchor::create(make_bound_anchor_platform());
	BOOST_REQUIRE(one);
	BOOST_REQUIRE(two);
	BOOST_CHECK_NE(one->operation_id(), two->operation_id());
	BOOST_CHECK(bound_encoding::token(one->operation_id(), 32));
	// Only the operation ID is deterministic here; sample the real Windows
	// clocks before and after each verification of the independent fixture.
	class FixtureWindowsClock final : public BoundAnchorPlatform {
		std::unique_ptr<BoundAnchorPlatform> native_ = make_bound_anchor_platform();

	public:
		bool random_operation(std::array<std::uint8_t, 32>& out) noexcept override {
			out.fill(11);
			return true;
		}
		bool sample(BoundClockSample& out) noexcept override { return native_ && native_->sample(out); }
	};
	Fixture f;
	auto anchor = BoundLeaseAnchor::create(std::make_unique<FixtureWindowsClock>());
	BOOST_REQUIRE(anchor);
	BoundLeaseClaims out;
	for (unsigned i = 0; i < 8; ++i) BOOST_REQUIRE(anchor->verify(f.token, f.keys, f.expected, out));
#else
	BOOST_CHECK(!make_bound_anchor_platform());
#endif
}

BOOST_AUTO_TEST_CASE(bias_uncertainty_only_narrows_across_observations) {
	Fixture f;
	auto platform = std::make_unique<FakePlatform>();
	auto* clock = platform.get();
	clock->clock = {1000, 990, 1000, 1};  // bias interval [0,10]
	auto anchor = BoundLeaseAnchor::create(std::move(platform));
	BOOST_REQUIRE(anchor);
	BoundLeaseClaims out;
	clock->clock = {2010, 2000, 2010, 1};  // [0,10]
	BOOST_REQUIRE(anchor->verify(f.token, f.keys, f.expected, out));
	clock->clock = {3020, 3000, 3010, 1};  // [10,20], intersection is now {10}
	BOOST_REQUIRE(anchor->verify(f.token, f.keys, f.expected, out));
	clock->clock = {4030, 4000, 4010, 1};  // [20,30] intersects previous sample only
	BOOST_CHECK(!anchor->verify(f.token, f.keys, f.expected, out));
}

BOOST_AUTO_TEST_CASE(zero_sleep_bias_allows_a_negative_lower_bound_but_not_an_entire_negative_interval) {
	Fixture f;
	auto platform = std::make_unique<FakePlatform>();
	auto* clock = platform.get();
	clock->clock = {1005, 1000, 1010, 1};  // interval [-5,5] can contain zero
	auto anchor = BoundLeaseAnchor::create(std::move(platform));
	BOOST_REQUIRE(anchor);
	clock->clock = {2005, 2000, 2010, 1};
	BoundLeaseClaims out;
	BOOST_REQUIRE(anchor->verify(f.token, f.keys, f.expected, out));
	clock->clock = {2999, 3000, 3010, 1};  // entirely negative is impossible
	BOOST_CHECK(!anchor->verify(f.token, f.keys, f.expected, out));
	clock->clock = {4005, 4000, 4010, 1};
	BOOST_CHECK(!anchor->verify(f.token, f.keys, f.expected, out));
	platform = std::make_unique<FakePlatform>();
	platform->clock = {999, 1000, 1010, 1};
	BOOST_CHECK(!BoundLeaseAnchor::create(std::move(platform)));
}

BOOST_AUTO_TEST_CASE(typed_check_reports_final_time_and_preserves_outputs_on_failure) {
	Fixture f;
	auto platform = std::make_unique<FakePlatform>();
	auto* clock = platform.get();
	auto anchor = BoundLeaseAnchor::create(std::move(platform));
	BOOST_REQUIRE(anchor);
	BoundLeaseClaims out;
	out.lease_id = "unchanged";
	std::uint64_t now = 17;
	auto result = anchor->check("bad", f.keys, f.expected, out, now);
	BOOST_CHECK(result == BoundAnchorResult::invalid_lease);
	BOOST_CHECK_EQUAL(out.lease_id, "unchanged");
	BOOST_CHECK_EQUAL(now, 17U);
	clock->jump_call = 4;
	clock->jump_ticks = second;
	BOOST_REQUIRE(anchor->check(f.token, f.keys, f.expected, out, now) == BoundAnchorResult::accepted);
	BOOST_CHECK_EQUAL(now, out.issued_at + 1);
	const auto accepted = out.lease_id;
	const auto accepted_time = now;
	clock->clock_ok = false;
	BOOST_CHECK(anchor->check(f.token, f.keys, f.expected, out, now) == BoundAnchorResult::continuity_lost);
	clock->clock_ok = true;
	BOOST_CHECK(anchor->check(f.token, f.keys, f.expected, out, now) == BoundAnchorResult::continuity_lost);
	BOOST_CHECK_EQUAL(out.lease_id, accepted);
	BOOST_CHECK_EQUAL(now, accepted_time);
}
