#include "bound_checkpoint.hpp"
#include <utility>

namespace license {
namespace device_identity {
namespace {
struct Statement {
	BoundResumeStatement identity;
	BoundLeaseClaims claims;
};
bool inspect(const std::string& token, const std::vector<BoundLeaseTrustKey>& trust,
			 const BoundResumeExpected& expected, Statement& statement) {
	if (!verify_bound_resume_statement(token, trust, expected, statement.identity)) return false;
	// Decode the identical authenticated bytes solely for storage ordering.
	// This signed timestamp is never passed to a lease-authority clock.
	ParsedBoundLease parsed;
	if (!decode_bound_lease(token, parsed)) return false;
	statement.claims = std::move(parsed.claims);
	return true;
}
}  // namespace
BoundCheckpointDecision compare_bound_checkpoints(const std::string& candidate, const std::string* current,
												  const std::vector<BoundLeaseTrustKey>& trust,
												  const BoundResumeExpected& expected) noexcept {
	try {
		Statement next, prior;
		if (!inspect(candidate, trust, expected, next)) return BoundCheckpointDecision::invalid_candidate;
		if (!current) return BoundCheckpointDecision::replace;
		if (!inspect(*current, trust, expected, prior)) return BoundCheckpointDecision::invalid_stored;
		const auto& a = next.identity;
		const auto& b = prior.identity;
		if (a.binding_id != b.binding_id || a.license_fingerprint != b.license_fingerprint ||
			a.generation != b.generation)
			return BoundCheckpointDecision::conflict;
		if (candidate == *current) return BoundCheckpointDecision::unchanged;
		if (a.revision_floor < b.revision_floor) return BoundCheckpointDecision::stale;
		if (a.revision_floor > b.revision_floor) return BoundCheckpointDecision::replace;
		if (next.claims.issued_at < prior.claims.issued_at) return BoundCheckpointDecision::stale;
		if (next.claims.issued_at > prior.claims.issued_at) return BoundCheckpointDecision::replace;
		// Independent requests can issue within one second. Context, binding,
		// generation and revision already match; only request/lease IDs may differ.
		// Equivalent historical identity does not restore either operation's clock
		// anchor or authorize work. Signer and validity changes still conflict.
		if (next.claims.signer_key_id == prior.claims.signer_key_id &&
			next.claims.renew_after == prior.claims.renew_after && next.claims.expires_at == prior.claims.expires_at)
			return BoundCheckpointDecision::unchanged;
		return BoundCheckpointDecision::conflict;
	} catch (...) {
		return BoundCheckpointDecision::internal_error;
	}
}
}  // namespace device_identity
}  // namespace license
