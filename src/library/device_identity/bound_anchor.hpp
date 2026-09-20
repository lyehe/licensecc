#ifndef LICENSECC_BOUND_ANCHOR_HPP_
#define LICENSECC_BOUND_ANCHOR_HPP_
#include "bound_lease.hpp"
#include <array>
#include <memory>
#include <mutex>

namespace license {
namespace device_identity {
// Internal platform seam. Ticks are 100 ns; awake readings bracket inclusive.
struct BoundClockSample {
	std::uint64_t inclusive = 0, awake_before = 0, awake_after = 0, process_id = 0;
};
class BoundAnchorPlatform {
public:
	virtual ~BoundAnchorPlatform() = default;
	virtual bool random_operation(std::array<std::uint8_t, 32>&) noexcept = 0;
	virtual bool sample(BoundClockSample&) noexcept = 0;
};
enum class BoundAnchorResult { accepted, invalid_lease, continuity_lost, internal_error };
// Windows pilot only. Unsupported platforms fail closed, with no wall-clock
// fallback. Tests inject a platform through this private native header.
std::unique_ptr<BoundAnchorPlatform> make_bound_anchor_platform() noexcept;
bool bound_effective_time(std::uint64_t issued_at, std::uint64_t original_ticks, std::uint64_t current_ticks,
						  std::uint64_t& out) noexcept;

// Create before the first request I/O. One object is one immutable operation;
// retries reuse operation_id(). No persisted-state/import or reset API exists.
class BoundLeaseAnchor {
public:
	static std::unique_ptr<BoundLeaseAnchor> create(std::unique_ptr<BoundAnchorPlatform>) noexcept;
	BoundLeaseAnchor(const BoundLeaseAnchor&) = delete;
	BoundLeaseAnchor& operator=(const BoundLeaseAnchor&) = delete;
	const std::string& operation_id() const noexcept { return operation_id_; }
	bool verify(const std::string& token, const std::vector<BoundLeaseTrustKey>& keys,
				const BoundLeaseExpected& expected, BoundLeaseClaims& out) noexcept;
	BoundAnchorResult check(const std::string& token, const std::vector<BoundLeaseTrustKey>& keys,
							const BoundLeaseExpected& expected, BoundLeaseClaims& out,
							std::uint64_t& effective_time) noexcept;

private:
	BoundLeaseAnchor() = default;
	bool observe(const BoundClockSample&) noexcept;
	std::unique_ptr<BoundAnchorPlatform> platform_;
	std::string operation_id_;
	BoundClockSample original_, previous_;
	std::int64_t bias_low_ = 0, bias_high_ = 0;
	bool live_ = false;
	std::mutex mutex_;
};
}  // namespace device_identity
}  // namespace license
#endif
