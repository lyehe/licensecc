#include "bound_enrollment.hpp"
#include "bound_encoding.hpp"
#include "device_identity_handle.hpp"

namespace license {
namespace device_identity {
namespace {
BoundEnrollmentResult result(BoundEnrollmentStatus status, const std::string& code = {}) { return {status, code}; }
BoundRenewResult exchange_result(BoundRenewStatus status) {
	BoundRenewResult out;
	out.status = status;
	return out;
}
void wipe(std::string& text) noexcept {
	secure_zero(text.data(), text.size());
	text.clear();
}
bool same_state(std::string_view left, std::string_view right) {
	if (left.size() != 43 || right.size() != 43) return false;
	unsigned difference = 0;
	for (std::size_t i = 0; i < 43; ++i)
		difference |= static_cast<unsigned char>(left[i]) ^ static_cast<unsigned char>(right[i]);
	return difference == 0;
}
}  // namespace
std::unique_ptr<BoundEnrollmentFlow> BoundEnrollmentFlow::create(
	BoundIdentityOwner identity, BoundEnrollmentOptions options, std::vector<BoundLeaseTrustKey> trust,
	BoundRenewalSession::PlatformFactory clock, BoundRenewalClient::TransportFactory transport) noexcept {
	try {
		if (!identity || !clock || !transport || !valid_bound_portal_url(options.portal_authorization_url) ||
			!bound_encoding::name(options.client_id))
			return nullptr;
		auto flow = std::unique_ptr<BoundEnrollmentFlow>(new BoundEnrollmentFlow);
		flow->request_.client_id = options.client_id;
		flow->request_.project = options.session.project;
		flow->request_.device_label = options.device_label;
		flow->request_.public_key_spki = bound_encoding::base64url(identity->spki.data(), identity->spki.size());
		flow->key_id_ = device_key_id(identity->spki);
		if (!bound_encoding::key_id_valid(flow->key_id_)) return nullptr;
		flow->client_ = BoundRenewalClient::create_for_enrollment(
			std::move(identity), options.session, std::move(trust), options.endpoint_origin, clock, transport);
		if (!flow->client_) return nullptr;
		flow->transport_ = transport(options.endpoint_origin);
		flow->clock_ = clock();
		if (!flow->transport_ || !flow->clock_) return nullptr;
		flow->draft_.value.code.reserve(43);
		flow->draft_.value.code_verifier.reserve(43);
		flow->options_ = std::move(options);
		return flow;
	} catch (...) {
		return nullptr;
	}
}
BoundEnrollmentFlow::~BoundEnrollmentFlow() { clear_secrets(); }
void BoundEnrollmentFlow::clear_secrets() noexcept {
	wipe_bound_exchange(draft_.value);
	wipe(request_.state);
	request_.code_challenge.clear();
	wipe(view_.authorization_url);
	view_.comparison_code.clear();
	view_.expires_at = 0;
}
BoundEnrollmentResult BoundEnrollmentFlow::expire() noexcept {
	clear_secrets();
	stage_ = Stage::failed;
	return {BoundEnrollmentStatus::expired, {}};
}
bool BoundEnrollmentFlow::live() { return within(start_.inclusive, 300ULL * 10000000); }
bool BoundEnrollmentFlow::within(std::uint64_t origin, std::uint64_t duration) {
	BoundClockSample now;
	if (!clock_->sample(now) || now.process_id == 0 || now.process_id != start_.process_id ||
		now.inclusive < previous_.inclusive || now.inclusive < origin)
		return false;
	previous_ = now;
	// Consent can survive suspend; this inclusive timer bounds only browser
	// admission. It cannot establish an offline lease or a renewal anchor.
	return now.inclusive - origin < duration;
}
BoundEnrollmentResult BoundEnrollmentFlow::begin(const std::string& redirect, BoundEnrollmentView& out) noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return result(BoundEnrollmentStatus::busy);
		try {
			if (!bound_encoding::loopback_uri(redirect)) return result(BoundEnrollmentStatus::invalid_input);
			if (stage_ != Stage::idle && stage_ != Stage::registering && stage_ != Stage::awaiting_callback)
				return result(BoundEnrollmentStatus::invalid_input);
			if (stage_ != Stage::idle && redirect != request_.redirect_uri)
				return result(BoundEnrollmentStatus::invalid_input);
			if (stage_ == Stage::idle) {
				SensitiveArray<32> state, verifier, hash;
				if (!clock_->sample(start_) || !start_.process_id || !clock_->random_operation(state.value) ||
					!clock_->random_operation(verifier.value) || state.value == verifier.value)
					return result(BoundEnrollmentStatus::failed);
				previous_ = start_;
				request_.redirect_uri = redirect;
				draft_.value.redirect_uri = redirect;
				request_.state = bound_encoding::base64url(state.value.data(), state.value.size());
				draft_.value.code_verifier = bound_encoding::base64url(verifier.value.data(), verifier.value.size());
				if (!sha256(reinterpret_cast<const std::uint8_t*>(draft_.value.code_verifier.data()),
							draft_.value.code_verifier.size(), hash.value)) {
					clear_secrets();
					stage_ = Stage::failed;
					return result(BoundEnrollmentStatus::failed);
				}
				request_.code_challenge = bound_encoding::base64url(hash.value.data(), hash.value.size());
				stage_ = Stage::registering;
			}
			if (!live()) return expire();
			if (stage_ == Stage::awaiting_callback) {
				auto copy = view_;
				out = std::move(copy);
				return result(BoundEnrollmentStatus::ready);
			}
			SensitiveVector body;
			if (!encode_bound_authorization(request_, body)) {
				clear_secrets();
				stage_ = Stage::failed;
				return result(BoundEnrollmentStatus::invalid_input);
			}
			BoundHttpResponse response;
			const auto http = transport_->post(
				BoundWireOperation::authorize,
				std::string_view(reinterpret_cast<const char*>(body.value.data()), body.value.size()), response);
			if (!live()) return expire();
			if (http == BoundHttpStatus::unavailable) return result(BoundEnrollmentStatus::retry);
			if (http != BoundHttpStatus::complete) return result(BoundEnrollmentStatus::invalid_response);
			BoundWireResponse decoded;
			if (!decode_bound_device_response(BoundWireOperation::authorize, response.status, response.body, decoded))
				return result(BoundEnrollmentStatus::invalid_response);
			if (decoded.kind == BoundWireKind::retry) return result(BoundEnrollmentStatus::retry, decoded.code);
			if (decoded.kind != BoundWireKind::registration) {
				clear_secrets();
				stage_ = Stage::failed;
				return result(decoded.kind == BoundWireKind::authority_denied ? BoundEnrollmentStatus::denied
																			  : BoundEnrollmentStatus::failed,
							  decoded.code);
			}
			std::string comparison;
			if (decoded.authorization_url !=
					options_.portal_authorization_url + "#attempt_handle=" + decoded.attempt_handle ||
				!enrollment_comparison_code_v1({decoded.attempt_handle, request_.client_id, request_.project, redirect,
												request_.state, request_.code_challenge},
											   key_id_, comparison) ||
				comparison != decoded.comparison_code)
				return result(BoundEnrollmentStatus::invalid_response);
			BoundEnrollmentView candidate{decoded.authorization_url, comparison, decoded.authorization_expires_at};
			auto output = candidate;
			if (!live()) return expire();
			draft_.value.attempt_handle = std::move(decoded.attempt_handle);
			view_ = std::move(candidate);
			stage_ = Stage::awaiting_callback;
			out = std::move(output);
			return result(BoundEnrollmentStatus::ready);
		} catch (...) {
			if (stage_ == Stage::idle) {
				clear_secrets();
				stage_ = Stage::failed;
			}
			return result(BoundEnrollmentStatus::failed);
		}
	} catch (...) {
		return result(BoundEnrollmentStatus::failed);
	}
}
BoundEnrollmentResult BoundEnrollmentFlow::receive_callback(std::string_view uri) noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return result(BoundEnrollmentStatus::busy);
		if (stage_ != Stage::awaiting_callback && stage_ != Stage::code_ready)
			return result(BoundEnrollmentStatus::invalid_input);
		if (exchange_started_ && !within(recovery_start_, 48ULL * 3600 * 10000000)) {
			finish_exchange();
			return result(BoundEnrollmentStatus::expired);
		}
		if (!exchange_started_ && !live()) return expire();
		const auto& redirect = request_.redirect_uri;
		if (uri.size() > 2048 || uri.size() <= redirect.size() || uri.substr(0, redirect.size()) != redirect ||
			uri[redirect.size()] != '?')
			return result(BoundEnrollmentStatus::invalid_input);
		const auto query = uri.substr(redirect.size() + 1);
		const auto amp = query.find('&');
		if (amp == std::string_view::npos || query.find('&', amp + 1) != std::string_view::npos)
			return result(BoundEnrollmentStatus::invalid_input);
		std::string_view code, state;
		for (const auto pair : {query.substr(0, amp), query.substr(amp + 1)}) {
			const auto equal = pair.find('=');
			if (equal == std::string_view::npos) return result(BoundEnrollmentStatus::invalid_input);
			const auto name = pair.substr(0, equal), value = pair.substr(equal + 1);
			if (name == "code" && code.empty())
				code = value;
			else if (name == "state" && state.empty())
				state = value;
			else
				return result(BoundEnrollmentStatus::invalid_input);
		}
		if (!bound_encoding::token(code, 32) || !bound_encoding::token(state, 32) || !same_state(state, request_.state))
			return result(BoundEnrollmentStatus::invalid_input);
		if (stage_ == Stage::code_ready)
			return result(code == draft_.value.code ? BoundEnrollmentStatus::callback_received
													: BoundEnrollmentStatus::invalid_input);
		draft_.value.code.assign(code.data(), code.size());
		stage_ = Stage::code_ready;
		return result(BoundEnrollmentStatus::callback_received);
	} catch (...) {
		return result(BoundEnrollmentStatus::failed);
	}
}
BoundEnrollmentResult BoundEnrollmentFlow::check_browser_ready() noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return result(BoundEnrollmentStatus::busy);
		if (stage_ != Stage::awaiting_callback) return result(BoundEnrollmentStatus::invalid_input);
		return live() ? result(BoundEnrollmentStatus::ready) : expire();
	} catch (...) {
		return result(BoundEnrollmentStatus::failed);
	}
}
bool BoundEnrollmentFlow::export_resume_statement(std::string& out) noexcept {
	return capture_resume_statement(out) == BoundResumeExport::exported;
}
BoundResumeExport BoundEnrollmentFlow::capture_resume_statement(std::string& out) noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return BoundResumeExport::busy;
		return client_ ? client_->capture_resume_statement(out) : BoundResumeExport::absent;
	} catch (...) {
		return BoundResumeExport::error;
	}
}
BoundRenewResult BoundEnrollmentFlow::activate() noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return exchange_result(BoundRenewStatus::busy);
		if (stage_ != Stage::code_ready) return exchange_result(BoundRenewStatus::rejected);
		if (!exchange_started_ && !live()) {
			expire();
			return exchange_result(BoundRenewStatus::enrollment_required);
		}
		if (exchange_started_ && !within(recovery_start_, 48ULL * 3600 * 10000000)) return finish_exchange();
		const auto attempted_at = previous_.inclusive;
		auto outcome = client_->activate(draft_.value);
		if (!exchange_started_ && client_->has_pending_enrollment()) {
			recovery_start_ = attempted_at;
			exchange_started_ = true;
		}
		if (outcome.status == BoundRenewStatus::accepted) {
			clear_secrets();
			stage_ = Stage::connected;
		} else if (outcome.status == BoundRenewStatus::renewal_required ||
				   (outcome.status == BoundRenewStatus::session_error &&
					client_->phase() == BoundSessionPhase::renewal)) {
			clear_secrets();
			stage_ = Stage::renewal_ready;
			outcome.status = BoundRenewStatus::renewal_required;
		} else if (outcome.status == BoundRenewStatus::enrollment_required ||
				   outcome.status == BoundRenewStatus::denied || outcome.status == BoundRenewStatus::rejected) {
			client_->abandon_renewal();
			clear_secrets();
			stage_ = Stage::failed;
		}
		// Retry/ambiguous conflict/invalid response retain code, verifier and
		// native pending intent even after the original browser deadline.
		if (stage_ == Stage::code_ready && exchange_started_ && !within(recovery_start_, 48ULL * 3600 * 10000000))
			return finish_exchange();
		return outcome;
	} catch (...) {
		return exchange_result(BoundRenewStatus::internal_error);
	}
}
BoundRenewResult BoundEnrollmentFlow::finish_exchange() {
	client_->abandon_renewal();
	clear_secrets();
	const auto phase = client_->phase();
	if (phase == BoundSessionPhase::renewal) {
		stage_ = Stage::renewal_ready;
		return exchange_result(BoundRenewStatus::renewal_required);
	}
	stage_ = Stage::failed;
	return exchange_result(phase == BoundSessionPhase::enrollment ? BoundRenewStatus::enrollment_required
																  : BoundRenewStatus::internal_error);
}
BoundRenewResult BoundEnrollmentFlow::abandon_exchange() noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return exchange_result(BoundRenewStatus::busy);
		if (stage_ != Stage::code_ready || !exchange_started_) return exchange_result(BoundRenewStatus::rejected);
		return finish_exchange();
	} catch (...) {
		return exchange_result(BoundRenewStatus::internal_error);
	}
}
BoundEnrollmentResult BoundEnrollmentFlow::cancel() noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return result(BoundEnrollmentStatus::busy);
		if (stage_ == Stage::transferred) return result(BoundEnrollmentStatus::invalid_input);
		clear_secrets();
		client_.reset();
		stage_ = Stage::cancelled;
		return result(BoundEnrollmentStatus::cancelled);
	} catch (...) {
		return result(BoundEnrollmentStatus::failed);
	}
}
std::unique_ptr<BoundRenewalClient> BoundEnrollmentFlow::take_client() noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock() || !client_ || client_->phase() != BoundSessionPhase::renewal ||
			(stage_ != Stage::connected && stage_ != Stage::renewal_ready && stage_ != Stage::failed))
			return nullptr;
		clear_secrets();
		stage_ = Stage::transferred;
		return std::move(client_);
	} catch (...) {
		return nullptr;
	}
}
}  // namespace device_identity
}  // namespace license
