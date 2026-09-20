#include "bound_session.hpp"
#include "bound_encoding.hpp"
#include "bound_possession.hpp"
#include "device_identity_handle.hpp"
#include <algorithm>

namespace license {
namespace device_identity {
namespace {
BoundSessionDecision status(BoundSessionStatus value) { return {value, LCC_DEVICE_OK, 0, false}; }
BoundSessionDecision provider(LCC_DEVICE_RESULT value) {
	return {value == LCC_DEVICE_OK ? BoundSessionStatus::ok : BoundSessionStatus::provider_error, value, 0, false};
}
bool valid_context(const BoundSessionContext& c, const LccDeviceIdentity& identity, bool enrollment) {
	const auto& e = c.lease;
	if (!e.operation_id.empty() || !bound_encoding::utf8_text(e.issuer) || !bound_encoding::utf8_text(e.audience) ||
		!bound_encoding::utf8_text(c.proof_audience) || !bound_encoding::name(e.project) ||
		!bound_encoding::name(e.feature, 15) || !bound_encoding::key_id_valid(e.device_key_id) ||
		e.min_revocation_seq > 9007199254740991ULL || !identity.provider || identity.project != e.project ||
		identity.device_key_id != e.device_key_id || device_key_id(identity.spki) != e.device_key_id)
		return false;
	if (enrollment) {
		if (!e.license_fingerprint.empty() || !e.binding_id.empty() || e.generation != 0 || e.min_revocation_seq != 0)
			return false;
	} else if (!bound_encoding::hex_digest(e.license_fingerprint) || !bound_encoding::token(e.binding_id, 16) ||
			   e.generation < 1 || e.generation > 9007199254740991ULL)
		return false;
	const auto& m = identity.provider_metadata;
	if (c.provider_policy == LCC_DEVICE_POLICY_HARDWARE_REQUIRED)
		return m.assurance == LCC_DEVICE_ASSURANCE_REPORTED_HARDWARE &&
			   (m.backend == LCC_DEVICE_BACKEND_WINDOWS_TPM || m.backend == LCC_DEVICE_BACKEND_TPM2_OPENSSL);
	return c.provider_policy == LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT && m.assurance == LCC_DEVICE_ASSURANCE_SOFTWARE &&
		   m.backend == LCC_DEVICE_BACKEND_SOFTWARE_TEST;
}
}  // namespace
BoundRenewalSession::~BoundRenewalSession() { clear_enrollment(); }
std::unique_ptr<BoundRenewalSession> BoundRenewalSession::create(BoundIdentityOwner identity,
																 BoundSessionContext context,
																 std::vector<BoundLeaseTrustKey> trust,
																 PlatformFactory factory) noexcept {
	return initialize(std::move(identity), std::move(context), std::move(trust), std::move(factory), false);
}
std::unique_ptr<BoundRenewalSession> BoundRenewalSession::create_for_enrollment(BoundIdentityOwner identity,
																				BoundEnrollmentContext context,
																				std::vector<BoundLeaseTrustKey> trust,
																				PlatformFactory factory) noexcept {
	try {
		if (!identity) return nullptr;
		BoundSessionContext pinned;
		pinned.lease = {context.issuer,
						context.lease_audience,
						context.project,
						context.feature,
						"",
						"",
						identity->device_key_id,
						"",
						0,
						0};
		pinned.proof_audience = std::move(context.proof_audience);
		pinned.provider_policy = context.provider_policy;
		return initialize(std::move(identity), std::move(pinned), std::move(trust), std::move(factory), true);
	} catch (...) {
		return nullptr;
	}
}
std::unique_ptr<BoundRenewalSession> BoundRenewalSession::initialize(BoundIdentityOwner identity,
																	 BoundSessionContext context,
																	 std::vector<BoundLeaseTrustKey> trust,
																	 PlatformFactory factory,
																	 bool enrollment) noexcept {
	try {
		if (!identity || !valid_context(context, *identity, enrollment) || !validate_bound_lease_trust(trust) ||
			!factory)
			return nullptr;
		auto session = std::unique_ptr<BoundRenewalSession>(new BoundRenewalSession);
		session->revision_floor_ = context.lease.min_revocation_seq;
		session->enrollment_ = enrollment;
		session->identity_ = std::move(identity);
		session->context_ = std::move(context);
		session->trust_ = std::move(trust);
		session->platform_factory_ = std::move(factory);
		return session;
	} catch (...) {
		return nullptr;
	}
}
std::unique_ptr<BoundRenewalSession> BoundRenewalSession::create_for_resume(BoundIdentityOwner identity,
																			BoundEnrollmentContext context,
																			std::vector<BoundLeaseTrustKey> trust,
																			const std::string& checkpoint,
																			PlatformFactory factory) noexcept {
	try {
		if (!identity || checkpoint.size() > 8192) return nullptr;
		auto stored = checkpoint;
		BoundResumeStatement statement;
		if (!verify_bound_resume_statement(
				stored, trust,
				{context.issuer, context.lease_audience, context.project, context.feature, identity->device_key_id},
				statement))
			return nullptr;
		BoundSessionContext pinned;
		pinned.lease = {context.issuer,
						context.lease_audience,
						context.project,
						context.feature,
						statement.license_fingerprint,
						statement.binding_id,
						identity->device_key_id,
						"",
						statement.generation,
						statement.revision_floor};
		pinned.proof_audience = std::move(context.proof_audience);
		pinned.provider_policy = context.provider_policy;
		auto session = initialize(std::move(identity), std::move(pinned), std::move(trust), std::move(factory), false);
		if (session) session->resume_statement_.swap(stored);
		return session;
	} catch (...) {
		return nullptr;
	}
}
bool BoundRenewalSession::export_resume_statement(std::string& out) noexcept {
	return capture_resume_statement(out) == BoundResumeExport::exported;
}
BoundResumeExport BoundRenewalSession::capture_resume_statement(std::string& out) noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return BoundResumeExport::busy;
		if (resume_statement_.empty()) return BoundResumeExport::absent;
		out.assign(resume_statement_);
		return BoundResumeExport::exported;
	} catch (...) {
		return BoundResumeExport::error;
	}
}
void BoundRenewalSession::clear_enrollment() noexcept { wipe_bound_exchange(enrollment_input_); }
void BoundRenewalSession::lose_continuity() noexcept {
	pending_.reset();
	accepted_.reset();
	clear_enrollment();
	if (!context_.lease.binding_id.empty()) enrollment_ = false;
}
BoundSessionDecision BoundRenewalSession::check(BoundLeaseAnchor& anchor, const std::string& token,
												BoundLeaseClaims& claims, std::string* checkpoint) {
	auto expected = context_.lease;
	expected.operation_id = anchor.operation_id();
	expected.min_revocation_seq = revision_floor_;
	std::uint64_t now = 0;
	const auto result = anchor.check(token, trust_, expected, claims, now);
	if (result == BoundAnchorResult::continuity_lost) {
		lose_continuity();
		return status(BoundSessionStatus::online_required);
	}
	if (result == BoundAnchorResult::internal_error) return status(BoundSessionStatus::internal_error);
	if (result != BoundAnchorResult::accepted) return status(BoundSessionStatus::invalid_response);
	// Retain authenticated policy advancement even when subsequent possession
	// or final deadline checks fail. Never use merely decoded claims here.
	if (checkpoint && claims.revocation_seq >= revision_floor_) resume_statement_.swap(*checkpoint);
	revision_floor_ = std::max(revision_floor_, claims.revocation_seq);
	return {BoundSessionStatus::ok,	   LCC_DEVICE_OK,	   now,
			now >= claims.renew_after, claims.renew_after, claims.expires_at};
}
BoundSessionDecision BoundRenewalSession::possession(const std::string& hash) {
	return provider(
		prove_bound_key_possession(identity_.get(), context_.lease.project, context_.lease.device_key_id, hash));
}
BoundSessionDecision BoundRenewalSession::begin_renewal(BoundRenewInput& out) noexcept {
	try {
		std::lock_guard<std::mutex> lock(mutex_);
		if (enrollment_) return status(BoundSessionStatus::online_required);
		if (!pending_) {
			auto anchor = BoundLeaseAnchor::create(platform_factory_());
			if (!anchor) return status(BoundSessionStatus::online_required);
			BoundRenewInput input{context_.lease.binding_id, context_.lease.generation, anchor->operation_id()};
			auto response = input;
			pending_input_ = std::move(input);
			pending_ = std::move(anchor);
			out = std::move(response);
		} else {
			auto response = pending_input_;
			out = std::move(response);
		}
		return status(BoundSessionStatus::ok);
	} catch (...) {
		return status(BoundSessionStatus::internal_error);
	}
}
BoundSessionDecision BoundRenewalSession::begin_enrollment(const BoundExchangeInput& draft,
														   BoundExchangeInput& out) noexcept {
	try {
		std::lock_guard<std::mutex> lock(mutex_);
		if (!enrollment_ || denied_)
			return status(denied_ ? BoundSessionStatus::denied : BoundSessionStatus::no_pending);
		if (!draft.operation_id.empty() || !bound_encoding::token(draft.attempt_handle, 32) ||
			!bound_encoding::token(draft.code, 32) || !bound_encoding::token(draft.code_verifier, 32) ||
			!bound_encoding::loopback_uri(draft.redirect_uri))
			return status(BoundSessionStatus::invalid_response);
		if (pending_) {
			if (draft.attempt_handle != enrollment_input_.attempt_handle || draft.code != enrollment_input_.code ||
				draft.code_verifier != enrollment_input_.code_verifier ||
				draft.redirect_uri != enrollment_input_.redirect_uri)
				return status(BoundSessionStatus::conflict);
		} else {
			auto anchor = BoundLeaseAnchor::create(platform_factory_());
			if (!anchor) return status(BoundSessionStatus::online_required);
			// Allocate every output before changing pending intent. Each bounded
			// secret-bearing copy has a wiping owner on exception as well.
			BoundExchangeSecret input(draft), response(draft);
			input.value.operation_id = anchor->operation_id();
			response.value.operation_id = anchor->operation_id();
			clear_enrollment();
			enrollment_input_ = std::move(input.value);
			pending_ = std::move(anchor);
			wipe_bound_exchange(out);
			out = std::move(response.value);
			return status(BoundSessionStatus::ok);
		}
		BoundExchangeSecret response(enrollment_input_);
		wipe_bound_exchange(out);
		out = std::move(response.value);
		return status(BoundSessionStatus::ok);
	} catch (...) {
		return status(BoundSessionStatus::internal_error);
	}
}
BoundSessionDecision BoundRenewalSession::sign_enrollment(const BoundChallenge& challenge,
														  BoundSignedProof& out) noexcept {
	try {
		std::lock_guard<std::mutex> lock(mutex_);
		if (!enrollment_ || !pending_) return status(BoundSessionStatus::no_pending);
		return provider(sign_bound_proof_v2(identity_.get(), {context_.lease.project, context_.proof_audience},
											enrollment_input_, challenge, out));
	} catch (...) {
		return status(BoundSessionStatus::internal_error);
	}
}
BoundSessionDecision BoundRenewalSession::sign_renewal(const BoundChallenge& challenge,
													   BoundSignedProof& out) noexcept {
	try {
		std::lock_guard<std::mutex> lock(mutex_);
		if (enrollment_ || !pending_) return status(BoundSessionStatus::no_pending);
		return provider(sign_bound_proof_v2(identity_.get(), {context_.lease.project, context_.proof_audience},
											pending_input_, challenge, out));
	} catch (...) {
		return status(BoundSessionStatus::internal_error);
	}
}
BoundSessionDecision BoundRenewalSession::abandon_renewal(const std::string& operation) noexcept {
	try {
		std::lock_guard<std::mutex> lock(mutex_);
		if (!pending_ || pending_->operation_id() != operation) return status(BoundSessionStatus::no_pending);
		pending_.reset();
		clear_enrollment();
		if (!context_.lease.binding_id.empty()) enrollment_ = false;
		return status(BoundSessionStatus::online_required);
	} catch (...) {
		return status(BoundSessionStatus::internal_error);
	}
}
BoundSessionDecision BoundRenewalSession::accept_renewal(const std::string& operation,
														 const std::string& token) noexcept {
	try {
		std::lock_guard<std::mutex> lock(mutex_);
		if (enrollment_) return status(BoundSessionStatus::no_pending);
		return accept(operation, token);
	} catch (...) {
		return status(BoundSessionStatus::internal_error);
	}
}
BoundSessionDecision BoundRenewalSession::accept_enrollment(const std::string& operation,
															const std::string& token) noexcept {
	try {
		std::lock_guard<std::mutex> lock(mutex_);
		if (!enrollment_ || !pending_ || operation != pending_->operation_id())
			return status(BoundSessionStatus::no_pending);
		if (context_.lease.binding_id.empty()) {
			ParsedBoundLease parsed;
			if (!decode_bound_lease(token, parsed)) return status(BoundSessionStatus::invalid_response);
			auto candidate = context_.lease;
			candidate.binding_id = parsed.claims.binding_id;
			candidate.license_fingerprint = parsed.claims.license_fingerprint;
			candidate.generation = parsed.claims.generation;
			candidate.operation_id = operation;
			auto checkpoint = token;
			BoundLeaseClaims verified;
			std::uint64_t now = 0;
			const auto checked = pending_->check(token, trust_, candidate, verified, now);
			if (checked == BoundAnchorResult::continuity_lost) {
				lose_continuity();
				return status(BoundSessionStatus::online_required);
			}
			if (checked != BoundAnchorResult::accepted)
				return status(checked == BoundAnchorResult::internal_error ? BoundSessionStatus::internal_error
																		   : BoundSessionStatus::invalid_response);
			// Only authenticated claims introduce authority identity. Preserve
			// these pins and floor even if later possession/time checks fail.
			candidate.binding_id = std::move(verified.binding_id);
			candidate.license_fingerprint = std::move(verified.license_fingerprint);
			candidate.generation = verified.generation;
			candidate.operation_id.clear();
			context_.lease = std::move(candidate);
			resume_statement_.swap(checkpoint);
			revision_floor_ = verified.revocation_seq;
		}
		const auto decision = accept(operation, token);
		if (decision.status == BoundSessionStatus::ok) {
			enrollment_ = false;
			clear_enrollment();
		}
		return decision;
	} catch (...) {
		return status(BoundSessionStatus::internal_error);
	}
}
BoundSessionDecision BoundRenewalSession::accept(const std::string& operation, const std::string& token) {
	if (!pending_ || operation != pending_->operation_id()) return status(BoundSessionStatus::no_pending);
	if (token.size() > 8192) return status(BoundSessionStatus::invalid_response);
	auto next = std::make_unique<Accepted>();
	// Allocate both copies before observing/promoting authenticated state.
	// Publication of checkpoint and revision then uses only nonthrowing swaps.
	next->token = token;
	auto checkpoint = token;
	auto decision = check(*pending_, token, next->claims, &checkpoint);
	if (decision.status != BoundSessionStatus::ok) return decision;
	P256Digest digest;
	if (!sha256(reinterpret_cast<const std::uint8_t*>(token.data()), token.size(), digest))
		return status(BoundSessionStatus::internal_error);
	next->hash = lowercase_hex(digest.data(), digest.size());
	decision = possession(next->hash);
	if (decision.status != BoundSessionStatus::ok) return decision;
	decision = check(*pending_, token, next->claims);
	if (decision.status != BoundSessionStatus::ok) return decision;
	next->anchor = std::move(pending_);
	accepted_ = std::move(next);
	denied_ = false;
	return decision;
}
BoundSessionDecision BoundRenewalSession::authorize_operation() noexcept {
	try {
		std::lock_guard<std::mutex> lock(mutex_);
		if (denied_) return status(BoundSessionStatus::denied);
		if (!accepted_) return status(BoundSessionStatus::online_required);
		BoundLeaseClaims claims;
		auto decision = check(*accepted_->anchor, accepted_->token, claims);
		if (decision.status != BoundSessionStatus::ok) return decision;
		decision = possession(accepted_->hash);
		if (decision.status != BoundSessionStatus::ok) return decision;
		return check(*accepted_->anchor, accepted_->token, claims);
	} catch (...) {
		return status(BoundSessionStatus::internal_error);
	}
}
BoundSessionPhase BoundRenewalSession::phase() noexcept {
	try {
		std::lock_guard<std::mutex> lock(mutex_);
		return enrollment_ ? BoundSessionPhase::enrollment : BoundSessionPhase::renewal;
	} catch (...) {
		return BoundSessionPhase::unavailable;
	}
}
bool BoundRenewalSession::has_pending_enrollment() noexcept {
	try {
		std::lock_guard<std::mutex> lock(mutex_);
		return enrollment_ && pending_ && !denied_;
	} catch (...) {
		return false;
	}
}
BoundSessionDecision BoundRenewalSession::record_outcome(const std::string& operation,
														 BoundTransportOutcome outcome) noexcept {
	try {
		std::lock_guard<std::mutex> lock(mutex_);
		if (!bound_encoding::token(operation, 32)) return status(BoundSessionStatus::invalid_response);
		if (outcome == BoundTransportOutcome::authority_denied) {
			pending_.reset();
			accepted_.reset();
			clear_enrollment();
			denied_ = true;
			if (!context_.lease.binding_id.empty()) enrollment_ = false;
			return status(BoundSessionStatus::denied);
		}
		const bool pending = pending_ && pending_->operation_id() == operation;
		const bool accepted = accepted_ && accepted_->anchor->operation_id() == operation;
		if (!pending && !accepted) return status(BoundSessionStatus::no_pending);
		switch (outcome) {
			case BoundTransportOutcome::transient:
				return status(BoundSessionStatus::ok);
			case BoundTransportOutcome::operation_expired:
				if (pending) {
					pending_.reset();
					clear_enrollment();
					if (!context_.lease.binding_id.empty()) enrollment_ = false;
				}
				return status(BoundSessionStatus::online_required);
			case BoundTransportOutcome::authority_denied:
				break;	// handled above
		}
		return status(BoundSessionStatus::invalid_response);
	} catch (...) {
		return status(BoundSessionStatus::internal_error);
	}
}
}  // namespace device_identity
}  // namespace license
