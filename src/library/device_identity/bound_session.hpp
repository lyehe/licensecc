#ifndef LICENSECC_BOUND_SESSION_HPP_
#define LICENSECC_BOUND_SESSION_HPP_
#include "bound_anchor.hpp"
#include "bound_protocol.hpp"
#include <functional>

namespace license {
namespace device_identity {
struct BoundIdentityCloser {
	void operator()(LccDeviceIdentity* identity) const noexcept { lcc_device_identity_close(identity); }
};
using BoundIdentityOwner = std::unique_ptr<LccDeviceIdentity, BoundIdentityCloser>;
struct BoundSessionContext {
	BoundLeaseExpected lease;  // operation_id must be empty; the session generates it.
	std::string proof_audience;
	LCC_DEVICE_POLICY provider_policy = LCC_DEVICE_POLICY_HARDWARE_REQUIRED;
};
struct BoundEnrollmentContext {
	std::string issuer, lease_audience, proof_audience, project, feature;
	LCC_DEVICE_POLICY provider_policy = LCC_DEVICE_POLICY_HARDWARE_REQUIRED;
};
enum class BoundSessionStatus {
	ok,
	online_required,
	invalid_response,
	no_pending,
	denied,
	provider_error,
	internal_error,
	conflict
};
enum class BoundSessionPhase { enrollment, renewal, unavailable };
struct BoundSessionDecision {
	BoundSessionStatus status = BoundSessionStatus::internal_error;
	LCC_DEVICE_RESULT provider_result = LCC_DEVICE_OK;
	std::uint64_t effective_time = 0;
	bool renewal_due = false;
	// Populated only by the existing final anchored verifier, never response
	// metadata. Private consumers may expose these as scheduling hints.
	std::uint64_t renew_after = 0;
	std::uint64_t expires_at = 0;
};
// Only a native authenticated transport classifier for this exact pinned
// context may supply these outcomes. Denials from superseded requests still
// stop authority: operation age alone cannot date the server's policy decision.
// Challenge expiry is transient; operation_expired means recovery is impossible.
enum class BoundTransportOutcome { transient, operation_expired, authority_denied };
class BoundRenewalSession {
public:
	using PlatformFactory = std::function<std::unique_ptr<BoundAnchorPlatform>()>;
	static std::unique_ptr<BoundRenewalSession> create(BoundIdentityOwner, BoundSessionContext,
													   std::vector<BoundLeaseTrustKey>,
													   PlatformFactory = make_bound_anchor_platform) noexcept;
	static std::unique_ptr<BoundRenewalSession> create_for_enrollment(
		BoundIdentityOwner, BoundEnrollmentContext, std::vector<BoundLeaseTrustKey>,
		PlatformFactory = make_bound_anchor_platform) noexcept;
	// Signed historical binding identity only: always starts online-only, with
	// no accepted lease, pending operation or restored clock anchor.
	static std::unique_ptr<BoundRenewalSession> create_for_resume(
		BoundIdentityOwner, BoundEnrollmentContext, std::vector<BoundLeaseTrustKey>, const std::string& checkpoint,
		PlatformFactory = make_bound_anchor_platform) noexcept;
	// Exact latest authenticated response checkpoint. False leaves out intact.
	// Export does not grant access or prove this file cannot be rolled back.
	bool export_resume_statement(std::string& out) noexcept;
	BoundResumeExport capture_resume_statement(std::string& out) noexcept;
	~BoundRenewalSession();
	BoundRenewalSession(const BoundRenewalSession&) = delete;
	BoundRenewalSession& operator=(const BoundRenewalSession&) = delete;
	BoundSessionDecision begin_renewal(BoundRenewInput& out) noexcept;
	// Draft operation_id must be empty. Codes/PKCE remain owned by the native
	// enrollment layer; retry requires the identical draft. No renewal before
	// successful signed bootstrap. Output includes the generated operation ID.
	BoundSessionDecision begin_enrollment(const BoundExchangeInput& draft, BoundExchangeInput& out) noexcept;
	BoundSessionDecision sign_enrollment(const BoundChallenge&, BoundSignedProof& out) noexcept;
	BoundSessionDecision accept_enrollment(const std::string& operation_id, const std::string& token) noexcept;
	// Explicit local abandonment, including expired delayed delivery. Does not
	// revoke server issuance or reset accepted authority/revision floor.
	BoundSessionDecision abandon_renewal(const std::string& operation_id) noexcept;
	BoundSessionDecision sign_renewal(const BoundChallenge&, BoundSignedProof& out) noexcept;
	BoundSessionDecision accept_renewal(const std::string& operation_id, const std::string& token) noexcept;
	BoundSessionDecision authorize_operation() noexcept;
	// Workflow phase only; never an authorization decision.
	BoundSessionPhase phase() noexcept;
	// Recovery eligibility only; a pending intent does not authorize access.
	bool has_pending_enrollment() noexcept;
	BoundSessionDecision record_outcome(const std::string& operation_id, BoundTransportOutcome) noexcept;

private:
	BoundRenewalSession() = default;
	static std::unique_ptr<BoundRenewalSession> initialize(BoundIdentityOwner, BoundSessionContext,
														   std::vector<BoundLeaseTrustKey>, PlatformFactory,
														   bool enrollment) noexcept;
	struct Accepted {
		std::unique_ptr<BoundLeaseAnchor> anchor;
		std::string token, hash;
		BoundLeaseClaims claims;
	};
	BoundSessionDecision check(BoundLeaseAnchor&, const std::string&, BoundLeaseClaims&,
							   std::string* checkpoint = nullptr);
	BoundSessionDecision accept(const std::string&, const std::string&);
	BoundSessionDecision possession(const std::string& hash);
	void clear_enrollment() noexcept;
	void lose_continuity() noexcept;
	BoundIdentityOwner identity_;
	BoundSessionContext context_;
	std::vector<BoundLeaseTrustKey> trust_;
	PlatformFactory platform_factory_;
	std::unique_ptr<BoundLeaseAnchor> pending_;
	BoundRenewInput pending_input_;
	BoundExchangeInput enrollment_input_;
	std::unique_ptr<Accepted> accepted_;
	std::string resume_statement_;
	std::uint64_t revision_floor_ = 0;
	bool denied_ = false;
	bool enrollment_ = false;
	std::mutex mutex_;
};
}  // namespace device_identity
}  // namespace license
#endif
