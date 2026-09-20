#ifndef LICENSECC_BOUND_LEASE_HPP_
#define LICENSECC_BOUND_LEASE_HPP_
#include <cstdint>
#include <string>
#include <vector>
namespace license {
namespace device_identity {
enum class BoundResumeExport { exported, absent, busy, error };
struct BoundLeaseClaims {
	std::string signer_key_id, issuer, audience, project, feature, license_fingerprint;
	std::string binding_id, device_key_id, lease_id, operation_id;
	std::uint64_t generation = 0, revocation_seq = 0, issued_at = 0, renew_after = 0, expires_at = 0;
};
struct BoundLeaseExpected {
	std::string issuer, audience, project, feature, license_fingerprint, binding_id, device_key_id, operation_id;
	std::uint64_t generation = 0, min_revocation_seq = 0;
};
struct BoundLeaseTrustKey {
	std::vector<std::uint8_t> spki;
	bool retired = false;
};
// Historical signed identity only. This statement cannot grant access, supply
// effective time, or restore a pending operation/clock anchor.
struct BoundResumeExpected {
	std::string issuer, audience, project, feature, device_key_id;
};
struct BoundResumeStatement {
	std::string binding_id, license_fingerprint;
	std::uint64_t generation = 0, revision_floor = 0;
};
struct ParsedBoundLease {
	BoundLeaseClaims claims;  // Untrusted until verify_bound_lease succeeds.
	std::vector<std::uint8_t> payload, signature;
};
bool validate_bound_lease_trust(const std::vector<BoundLeaseTrustKey>&) noexcept;
// Decode only; never use parsed claims to authorize a protected operation.
bool decode_bound_lease(const std::string& token, ParsedBoundLease& out) noexcept;
// Internal resume-only verifier: strict signed envelope/context and timestamp
// grammar, without a current-validity decision. Expired statements can identify
// a binding for fresh online renewal; unknown/retired signers are rejected.
bool verify_bound_resume_statement(const std::string&, const std::vector<BoundLeaseTrustKey>&,
								   const BoundResumeExpected&, BoundResumeStatement&) noexcept;
// Dedicated RSA-3072 SPKI trust ring, at most eight records, no embedded-key
// fallback. Identity, generation and revocation floor come from local context.
// effective_now must come from the fresh process-bound original-send anchor,
// never wall time or a receipt timestamp. No server hold allowance is added.
// On failure output remains unchanged; success alone does not prove local key
// possession or establish clock continuity.
bool verify_bound_lease(const std::string& token, const std::vector<BoundLeaseTrustKey>& trusted_keys,
						const BoundLeaseExpected& expected, std::uint64_t effective_now,
						BoundLeaseClaims& out) noexcept;
}  // namespace device_identity
}  // namespace license
#endif
