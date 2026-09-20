#include "bound_anchor.hpp"
#include "bound_encoding.hpp"
#include <algorithm>
#include <limits>

namespace license {
namespace device_identity {
namespace {
constexpr std::uint64_t safe_max = 9007199254740991ULL;
constexpr std::uint64_t ticks_per_second = 10000000;
bool sample_valid(const BoundClockSample& sample) {
	const auto maximum = static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max());
	return sample.process_id != 0 && sample.inclusive <= maximum && sample.awake_after <= maximum &&
		   sample.inclusive >= sample.awake_before && sample.awake_before <= sample.awake_after &&
		   sample.awake_after - sample.awake_before <= 100000;
}
std::int64_t low(const BoundClockSample& sample) {
	return static_cast<std::int64_t>(sample.inclusive) - static_cast<std::int64_t>(sample.awake_after);
}
std::int64_t high(const BoundClockSample& sample) {
	return static_cast<std::int64_t>(sample.inclusive) - static_cast<std::int64_t>(sample.awake_before);
}
}  // namespace
bool bound_effective_time(std::uint64_t issued_at, std::uint64_t original_ticks, std::uint64_t current_ticks,
						  std::uint64_t& out) noexcept {
	if (issued_at > safe_max || current_ticks < original_ticks) return false;
	const auto elapsed = current_ticks - original_ticks;
	const auto seconds = elapsed / ticks_per_second + (elapsed % ticks_per_second != 0 ? 1 : 0);
	if (seconds > safe_max - issued_at) return false;
	out = issued_at + seconds;
	return true;
}
std::unique_ptr<BoundLeaseAnchor> BoundLeaseAnchor::create(std::unique_ptr<BoundAnchorPlatform> platform) noexcept {
	try {
		if (!platform) return nullptr;
		std::array<std::uint8_t, 32> random{};
		auto anchor = std::unique_ptr<BoundLeaseAnchor>(new BoundLeaseAnchor);
		if (!platform->random_operation(random)) return nullptr;
		anchor->operation_id_ = bound_encoding::base64url(std::string(random.begin(), random.end()));
		if (!bound_encoding::token(anchor->operation_id_, 32) || !platform->sample(anchor->original_) ||
			!sample_valid(anchor->original_))
			return nullptr;
		anchor->previous_ = anchor->original_;
		anchor->bias_low_ = low(anchor->original_);
		anchor->bias_high_ = high(anchor->original_);
		anchor->platform_ = std::move(platform);
		anchor->live_ = true;
		return anchor;
	} catch (...) {
		return nullptr;
	}
}
bool BoundLeaseAnchor::observe(const BoundClockSample& sample) noexcept {
	if (!live_ || !sample_valid(sample) || sample.process_id != original_.process_id ||
		sample.inclusive < previous_.inclusive || sample.awake_before < previous_.awake_after ||
		sample.awake_after < previous_.awake_after) {
		live_ = false;
		return false;
	}
	const auto next_low = std::max(bias_low_, low(sample));
	const auto next_high = std::min(bias_high_, high(sample));
	if (next_low > next_high) {
		live_ = false;
		return false;
	}
	bias_low_ = next_low;
	bias_high_ = next_high;
	previous_ = sample;
	return true;
}
bool BoundLeaseAnchor::verify(const std::string& token, const std::vector<BoundLeaseTrustKey>& keys,
							  const BoundLeaseExpected& expected, BoundLeaseClaims& out) noexcept {
	std::uint64_t now = 0;
	return check(token, keys, expected, out, now) == BoundAnchorResult::accepted;
}
BoundAnchorResult BoundLeaseAnchor::check(const std::string& token, const std::vector<BoundLeaseTrustKey>& keys,
										  const BoundLeaseExpected& expected, BoundLeaseClaims& out,
										  std::uint64_t& effective_time) noexcept {
	try {
		std::lock_guard<std::mutex> lock(mutex_);
		if (!live_) return BoundAnchorResult::continuity_lost;
		if (expected.operation_id != operation_id_) return BoundAnchorResult::invalid_lease;
		BoundClockSample sample;
		if (!platform_->sample(sample)) {
			live_ = false;
			return BoundAnchorResult::continuity_lost;
		}
		if (!observe(sample)) return BoundAnchorResult::continuity_lost;
		ParsedBoundLease parsed;
		std::uint64_t now = 0;
		if (!decode_bound_lease(token, parsed) ||
			!bound_effective_time(parsed.claims.issued_at, original_.inclusive, sample.inclusive, now))
			return BoundAnchorResult::invalid_lease;
		// Untrusted issued-at only supplies arithmetic input. Full signature,
		// context and time verification below is required before publishing it.
		BoundLeaseClaims candidate;
		if (!verify_bound_lease(token, keys, expected, now, candidate)) return BoundAnchorResult::invalid_lease;
		// Crypto and scheduling time count too. Recheck continuity and expiry
		// before publishing accepted claims, without resetting the origin.
		if (!platform_->sample(sample)) {
			live_ = false;
			return BoundAnchorResult::continuity_lost;
		}
		if (!observe(sample)) return BoundAnchorResult::continuity_lost;
		if (!bound_effective_time(candidate.issued_at, original_.inclusive, sample.inclusive, now) ||
			now >= candidate.expires_at)
			return BoundAnchorResult::invalid_lease;
		out = std::move(candidate);
		effective_time = now;
		return BoundAnchorResult::accepted;
	} catch (...) {
		return BoundAnchorResult::internal_error;
	}
}
}  // namespace device_identity
}  // namespace license
