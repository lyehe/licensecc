#ifndef LICENSECC_BOUND_ENROLLMENT_HPP_
#define LICENSECC_BOUND_ENROLLMENT_HPP_
#include "bound_client.hpp"

namespace license {
namespace device_identity {
struct BoundEnrollmentOptions {
	BoundEnrollmentContext session;
	std::string endpoint_origin, portal_authorization_url, client_id, device_label;
};
struct BoundEnrollmentView {
	std::string authorization_url, comparison_code;
	std::uint64_t expires_at = 0;  // Server display metadata; not a lease clock.
};
enum class BoundEnrollmentStatus {
	ready,
	callback_received,
	retry,
	busy,
	invalid_input,
	invalid_response,
	expired,
	denied,
	cancelled,
	failed
};
struct BoundEnrollmentResult {
	BoundEnrollmentStatus status = BoundEnrollmentStatus::failed;
	std::string code;
};
// Internal enrollment owner. The native loopback/browser adapter must open its
// exclusive listener before begin, display comparison_code beside browser
// launch, and supply a validated full callback URI to receive_callback.
class BoundEnrollmentFlow {
public:
	static std::unique_ptr<BoundEnrollmentFlow> create(
		BoundIdentityOwner, BoundEnrollmentOptions, std::vector<BoundLeaseTrustKey>,
		BoundRenewalSession::PlatformFactory = make_bound_anchor_platform,
		BoundRenewalClient::TransportFactory = make_bound_http_transport) noexcept;
	~BoundEnrollmentFlow();
	BoundEnrollmentResult begin(const std::string& registered_redirect_uri, BoundEnrollmentView& out) noexcept;
	// No registration/network side effects; for launch admission and recheck.
	BoundEnrollmentResult check_browser_ready() noexcept;
	bool export_resume_statement(std::string& out) noexcept;
	BoundResumeExport capture_resume_statement(std::string& out) noexcept;
	BoundEnrollmentResult receive_callback(std::string_view full_callback_uri) noexcept;
	// Pending-exchange secrets expire lazily on callback/activation entry and
	// before a delayed retry returns, at 48h from the first owned attempt.
	// No background erasure timer; cancel/destruction also clear owned secrets.
	BoundRenewResult activate() noexcept;
	BoundRenewResult abandon_exchange() noexcept;
	// Local cancellation only. Returns busy during synchronous I/O; no claim
	// to cancel a request or undo a server allocation whose response was lost.
	BoundEnrollmentResult cancel() noexcept;
	// Transfer after success or when authenticated binding pins permit renewal
	// recovery. A transferred client may still be denied/online-only.
	std::unique_ptr<BoundRenewalClient> take_client() noexcept;

private:
	BoundEnrollmentFlow() = default;
	enum class Stage {
		idle,
		registering,
		awaiting_callback,
		code_ready,
		connected,
		renewal_ready,
		failed,
		cancelled,
		transferred
	};
	bool live();
	bool within(std::uint64_t origin, std::uint64_t duration);
	BoundRenewResult finish_exchange();
	void clear_secrets() noexcept;
	BoundEnrollmentResult expire() noexcept;
	BoundEnrollmentOptions options_;
	BoundAuthorizationInput request_;
	BoundExchangeSecret draft_;
	std::string key_id_;
	BoundEnrollmentView view_;
	std::unique_ptr<BoundRenewalClient> client_;
	std::unique_ptr<BoundHttpTransport> transport_;
	std::unique_ptr<BoundAnchorPlatform> clock_;
	BoundClockSample start_, previous_;
	std::uint64_t recovery_start_ = 0;
	Stage stage_ = Stage::idle;
	bool exchange_started_ = false;
	std::mutex mutex_;
};
}  // namespace device_identity
}  // namespace license
#endif
