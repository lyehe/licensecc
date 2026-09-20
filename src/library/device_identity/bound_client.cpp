#include "bound_client.hpp"

namespace license {
namespace device_identity {
namespace {
BoundRenewResult result(BoundRenewStatus status) {
	BoundRenewResult out;
	out.status = status;
	return out;
}
BoundRenewResult session_result(BoundSessionDecision decision) {
	auto out = result(decision.status == BoundSessionStatus::ok ? BoundRenewStatus::accepted
																: BoundRenewStatus::session_error);
	if (decision.status == BoundSessionStatus::conflict) out.status = BoundRenewStatus::conflict;
	if (decision.status == BoundSessionStatus::denied) out.status = BoundRenewStatus::denied;
	out.decision = decision;
	return out;
}
}  // namespace
std::unique_ptr<BoundRenewalClient> BoundRenewalClient::create(BoundIdentityOwner identity, BoundSessionContext context,
															   std::vector<BoundLeaseTrustKey> trust,
															   const std::string& origin,
															   BoundRenewalSession::PlatformFactory clock,
															   TransportFactory transport) noexcept {
	try {
		BoundHttpOrigin parsed;
		if (!parse_bound_http_origin(origin, parsed) || !transport) return nullptr;
		return initialize(
			BoundRenewalSession::create(std::move(identity), std::move(context), std::move(trust), std::move(clock)),
			origin, std::move(transport));
	} catch (...) {
		return nullptr;
	}
}
std::unique_ptr<BoundRenewalClient> BoundRenewalClient::create_for_enrollment(
	BoundIdentityOwner identity, BoundEnrollmentContext context, std::vector<BoundLeaseTrustKey> trust,
	const std::string& origin, BoundRenewalSession::PlatformFactory clock, TransportFactory transport) noexcept {
	try {
		BoundHttpOrigin parsed;
		if (!parse_bound_http_origin(origin, parsed) || !transport) return nullptr;
		return initialize(BoundRenewalSession::create_for_enrollment(std::move(identity), std::move(context),
																	 std::move(trust), std::move(clock)),
						  origin, std::move(transport));
	} catch (...) {
		return nullptr;
	}
}
std::unique_ptr<BoundRenewalClient> BoundRenewalClient::initialize(std::unique_ptr<BoundRenewalSession> session,
																   const std::string& origin,
																   TransportFactory factory) {
	if (!session) return nullptr;
	auto client = std::unique_ptr<BoundRenewalClient>(new BoundRenewalClient);
	client->session_ = std::move(session);
	client->transport_ = factory(origin);
	if (!client->transport_) return nullptr;
	return client;
}
std::unique_ptr<BoundRenewalClient> BoundRenewalClient::create_for_resume(
	BoundIdentityOwner identity, BoundEnrollmentContext context, std::vector<BoundLeaseTrustKey> trust,
	const std::string& origin, const std::string& checkpoint, BoundRenewalSession::PlatformFactory clock,
	TransportFactory transport) noexcept {
	try {
		BoundHttpOrigin parsed;
		if (!parse_bound_http_origin(origin, parsed) || !transport) return nullptr;
		return initialize(BoundRenewalSession::create_for_resume(std::move(identity), std::move(context),
																 std::move(trust), checkpoint, std::move(clock)),
						  origin, std::move(transport));
	} catch (...) {
		return nullptr;
	}
}
BoundRenewResult BoundRenewalClient::exchange(BoundWireOperation operation, const std::string& operation_id,
											  std::string_view body, BoundWireResponse& decoded) {
	BoundHttpResponse response;
	const auto http = transport_->post(operation, body, response);
	if (http == BoundHttpStatus::unavailable) return result(BoundRenewStatus::retry);
	if (http == BoundHttpStatus::internal_error) return result(BoundRenewStatus::internal_error);
	if (http != BoundHttpStatus::complete ||
		!decode_bound_device_response(operation, response.status, response.body, decoded))
		return result(BoundRenewStatus::invalid_response);
	auto out = result(BoundRenewStatus::accepted);
	out.code = decoded.code;
	switch (decoded.kind) {
		case BoundWireKind::authority_denied:
			out.decision = session_->record_outcome(operation_id, BoundTransportOutcome::authority_denied);
			out.status = out.decision.status == BoundSessionStatus::denied ? BoundRenewStatus::denied
																		   : BoundRenewStatus::session_error;
			pending_operation_.clear();
			break;
		case BoundWireKind::authorization_unavailable:
			out.decision = session_->record_outcome(operation_id, BoundTransportOutcome::operation_expired);
			switch (session_->phase()) {
				case BoundSessionPhase::enrollment:
					out.status = BoundRenewStatus::enrollment_required;
					break;
				case BoundSessionPhase::renewal:
					out.status = BoundRenewStatus::renewal_required;
					break;
				case BoundSessionPhase::unavailable:
					out.status = BoundRenewStatus::internal_error;
					break;
			}
			pending_operation_.clear();
			break;
		case BoundWireKind::retry:
			out.status = BoundRenewStatus::retry;
			break;
		case BoundWireKind::conflict:
			out.status = BoundRenewStatus::conflict;
			break;
		case BoundWireKind::request_rejected:
			out.status = BoundRenewStatus::rejected;
			break;
		case BoundWireKind::challenge:
		case BoundWireKind::lease:
			break;
		case BoundWireKind::registration:
			out.status = BoundRenewStatus::invalid_response;
			break;
	}
	return out;
}
BoundRenewResult BoundRenewalClient::renew() noexcept {
	try {
		std::unique_lock<std::mutex> lock(renewal_mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return result(BoundRenewStatus::busy);
		BoundRenewInput input;
		auto decision = session_->begin_renewal(input);
		if (decision.status != BoundSessionStatus::ok) return session_result(decision);
		pending_operation_ = input.operation_id;
		std::string body;
		if (!encode_bound_renew_challenge(input, body)) return result(BoundRenewStatus::internal_error);
		BoundWireResponse response;
		auto outcome = exchange(BoundWireOperation::renew_challenge, input.operation_id, body, response);
		if (outcome.status != BoundRenewStatus::accepted) return outcome;
		BoundSignedProof proof;
		decision = session_->sign_renewal(response.challenge, proof);
		if (decision.status != BoundSessionStatus::ok) return session_result(decision);
		if (!encode_bound_renew_request(input, proof, body)) return result(BoundRenewStatus::internal_error);
		outcome = exchange(BoundWireOperation::renew, input.operation_id, body, response);
		if (outcome.status != BoundRenewStatus::accepted) return outcome;
		decision = session_->accept_renewal(input.operation_id, response.lease);
		outcome = session_result(decision);
		outcome.code = response.code;
		if (decision.status == BoundSessionStatus::ok) pending_operation_.clear();
		return outcome;
	} catch (...) {
		return result(BoundRenewStatus::internal_error);
	}
}
BoundRenewResult BoundRenewalClient::activate(const BoundExchangeInput& draft) noexcept {
	try {
		std::unique_lock<std::mutex> lock(renewal_mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return result(BoundRenewStatus::busy);
		BoundExchangeSecret input;
		auto decision = session_->begin_enrollment(draft, input.value);
		if (decision.status != BoundSessionStatus::ok) return session_result(decision);
		pending_operation_ = input.value.operation_id;
		SensitiveVector body;
		if (!encode_bound_exchange_challenge(input.value, body)) return result(BoundRenewStatus::internal_error);
		const auto view = [&body] {
			return std::string_view(reinterpret_cast<const char*>(body.value.data()), body.value.size());
		};
		BoundWireResponse response;
		auto outcome = exchange(BoundWireOperation::enrollment_challenge, input.value.operation_id, view(), response);
		if (outcome.status != BoundRenewStatus::accepted) return outcome;
		BoundSignedProof proof;
		decision = session_->sign_enrollment(response.challenge, proof);
		if (decision.status != BoundSessionStatus::ok) return session_result(decision);
		if (!encode_bound_exchange_request(input.value, proof, body)) return result(BoundRenewStatus::internal_error);
		outcome = exchange(BoundWireOperation::exchange, input.value.operation_id, view(), response);
		if (outcome.status != BoundRenewStatus::accepted) return outcome;
		decision = session_->accept_enrollment(input.value.operation_id, response.lease);
		outcome = session_result(decision);
		outcome.code = response.code;
		if (decision.status == BoundSessionStatus::online_required) {
			// Acceptance may have invalidated the original anchor. Reusing a
			// consumed code under a fresh operation is not recovery.
			const auto phase = session_->phase();
			if (phase == BoundSessionPhase::enrollment)
				outcome.status = BoundRenewStatus::enrollment_required;
			else if (phase == BoundSessionPhase::renewal)
				outcome.status = BoundRenewStatus::renewal_required;
			pending_operation_.clear();
		}
		if (decision.status == BoundSessionStatus::ok) pending_operation_.clear();
		return outcome;
	} catch (...) {
		return result(BoundRenewStatus::internal_error);
	}
}
BoundSessionDecision BoundRenewalClient::authorize_operation() noexcept { return session_->authorize_operation(); }
BoundSessionDecision BoundRenewalClient::abandon_renewal() noexcept {
	try {
		std::unique_lock<std::mutex> lock(renewal_mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return {BoundSessionStatus::provider_error, LCC_DEVICE_BUSY, 0, false};
		const auto decision = session_->abandon_renewal(pending_operation_);
		pending_operation_.clear();
		return decision;
	} catch (...) {
		return {};
	}
}
}  // namespace device_identity
}  // namespace license
