#ifndef LICENSECC_BOUND_CLIENT_HPP_
#define LICENSECC_BOUND_CLIENT_HPP_
#include "bound_http.hpp"
#include "bound_session.hpp"

namespace license {
namespace device_identity {
enum class BoundRenewStatus {
	accepted,
	retry,
	conflict,
	rejected,
	denied,
	busy,
	session_error,
	invalid_response,
	internal_error,
	enrollment_required,
	renewal_required
};
struct BoundRenewResult {
	BoundRenewStatus status = BoundRenewStatus::internal_error;
	BoundSessionDecision decision;
	std::string code;
};
// Internal owner. Transport factory is a native test seam, not an application
// callback or response-input API. Origin, trust and session context are pinned
// together at creation; response data can never select another destination.
class BoundRenewalClient {
public:
	using TransportFactory = std::function<std::unique_ptr<BoundHttpTransport>(const std::string&)>;
	static std::unique_ptr<BoundRenewalClient> create(BoundIdentityOwner, BoundSessionContext,
													  std::vector<BoundLeaseTrustKey>,
													  const std::string& endpoint_origin,
													  BoundRenewalSession::PlatformFactory = make_bound_anchor_platform,
													  TransportFactory = make_bound_http_transport) noexcept;
	static std::unique_ptr<BoundRenewalClient> create_for_enrollment(
		BoundIdentityOwner, BoundEnrollmentContext, std::vector<BoundLeaseTrustKey>, const std::string& endpoint_origin,
		BoundRenewalSession::PlatformFactory = make_bound_anchor_platform,
		TransportFactory = make_bound_http_transport) noexcept;
	static std::unique_ptr<BoundRenewalClient> create_for_resume(
		BoundIdentityOwner, BoundEnrollmentContext, std::vector<BoundLeaseTrustKey>, const std::string& endpoint_origin,
		const std::string& checkpoint, BoundRenewalSession::PlatformFactory = make_bound_anchor_platform,
		TransportFactory = make_bound_http_transport) noexcept;
	bool export_resume_statement(std::string& out) noexcept { return session_->export_resume_statement(out); }
	BoundResumeExport capture_resume_statement(std::string& out) noexcept {
		return session_->capture_resume_statement(out);
	}
	// Internal native consent owner supplies verified callback/code/PKCE draft.
	// No browser callback or untrusted metadata directly creates authority.
	BoundRenewResult activate(const BoundExchangeInput& draft) noexcept;
	BoundRenewResult renew() noexcept;
	BoundSessionDecision authorize_operation() noexcept;
	BoundSessionPhase phase() noexcept { return session_->phase(); }
	bool has_pending_enrollment() noexcept { return session_->has_pending_enrollment(); }
	// Explicitly abandon an unresolved local operation. No automatic restart on
	// idempotency conflict; callers must surface/reconcile ambiguous issuance.
	BoundSessionDecision abandon_renewal() noexcept;

private:
	BoundRenewalClient() = default;
	static std::unique_ptr<BoundRenewalClient> initialize(std::unique_ptr<BoundRenewalSession>, const std::string&,
														  TransportFactory);
	BoundRenewResult exchange(BoundWireOperation, const std::string& operation_id, std::string_view,
							  BoundWireResponse&);
	std::unique_ptr<BoundRenewalSession> session_;
	std::unique_ptr<BoundHttpTransport> transport_;
	std::string pending_operation_;
	std::mutex renewal_mutex_;
};
}  // namespace device_identity
}  // namespace license
#endif
