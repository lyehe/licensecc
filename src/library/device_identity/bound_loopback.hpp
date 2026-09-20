#ifndef LICENSECC_BOUND_LOOPBACK_HPP_
#define LICENSECC_BOUND_LOOPBACK_HPP_
#include "bound_enrollment.hpp"

namespace license {
namespace device_identity {
enum class BoundLoopbackStatus { waiting, rejected, received, expired, closed, busy, failed };
// Internal Windows transport, not a public callback-authority API. Open before
// registration; poll feeds only strict HTTP callbacks to the enrollment owner.
// Destruction requires callers to have stopped using this object.
class BoundLoopbackListener {
public:
	// Private native test seam. This clock only bounds the listener; it cannot
	// replace the enrollment/session clocks or establish license authority.
	using Clock = std::function<std::uint64_t()>;
	static std::unique_ptr<BoundLoopbackListener> create(const std::string& registered_path, bool ipv6 = false,
														 Clock = {}) noexcept;
	~BoundLoopbackListener();
	const std::string& redirect_uri() const noexcept { return redirect_uri_; }
	BoundLoopbackStatus check() noexcept;
	BoundLoopbackStatus poll(BoundEnrollmentFlow&, unsigned wait_ms = 100) noexcept;
	// Cancels sockets only; the higher enrollment owner must cancel its flow
	// as well. Returns busy during poll. Pending OS accept cancellation is
	// observed before releasing storage, with no hard cancellation deadline.
	BoundLoopbackStatus close() noexcept;

private:
	struct Impl;
	BoundLoopbackListener();
	std::unique_ptr<Impl> impl_;
	std::string redirect_uri_;
	std::mutex mutex_;
};
}  // namespace device_identity
}  // namespace license
#endif
