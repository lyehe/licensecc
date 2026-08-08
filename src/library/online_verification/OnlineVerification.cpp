#include "OnlineVerification.hpp"

#include <algorithm>
#include <cctype>
#include <ctime>
#include <exception>
#include <map>
#include <mutex>
#include <sstream>
#include <tuple>
#include <vector>

#include "../base/EventRegistry.h"
#include "../base/base64.h"
#include "../base/string_utils.h"
#include "../os/os.h"
#include "../os/signature_verifier.hpp"
#include "../signed_token/SignedToken.hpp"

namespace license {
namespace online_verification {
namespace {

const char kEnvelopePrefix[] = "lccoa1";
const char kPurpose[] = "licensecc-online-assertion";
const char kVersion[] = "1";
const char kReference[] = "OnlineVerification";
const uint64_t kIssuedAtFutureSkewSeconds = 300;

using RevocationFloorKey = std::tuple<std::string, std::string, std::string>;

using OVKeyOverride = license::signed_token::TrustedKeyOverride<OnlineVerificationPublicKey>;

std::map<RevocationFloorKey, uint64_t>& revocation_floors() {
	static std::map<RevocationFloorKey, uint64_t> floors;
	return floors;
}

std::mutex& revocation_floors_mutex() {
	static std::mutex mutex;
	return mutex;
}

RevocationFloorKey floor_key(const std::string& project, const std::string& feature,
							 const std::string& license_fingerprint) {
	return RevocationFloorKey(project, feature, license_fingerprint);
}

uint64_t current_revocation_floor(const std::string& project, const std::string& feature,
								  const std::string& license_fingerprint) {
	std::lock_guard<std::mutex> lock(revocation_floors_mutex());
	const std::map<RevocationFloorKey, uint64_t>& floors = revocation_floors();
	const std::map<RevocationFloorKey, uint64_t>::const_iterator it =
		floors.find(floor_key(project, feature, license_fingerprint));
	return it == floors.end() ? 0 : it->second;
}

void advance_revocation_floor(const std::string& project, const std::string& feature,
							  const std::string& license_fingerprint, const uint64_t revocation_seq) {
	std::lock_guard<std::mutex> lock(revocation_floors_mutex());
	uint64_t& floor = revocation_floors()[floor_key(project, feature, license_fingerprint)];
	if (revocation_seq > floor) {
		floor = revocation_seq;
	}
}

bool is_ascii_hex(const std::string& value, const size_t expected_size) {
	if (value.size() != expected_size) {
		return false;
	}
	for (const unsigned char ch : value) {
		if (!std::isxdigit(ch)) {
			return false;
		}
	}
	return true;
}

license::os::SignatureVerificationPolicy signature_policy_for_expected(const OnlineVerificationExpected& expected) {
	license::os::SignatureVerificationPolicy policy = license::os::online_assertion_signature_policy();
	const std::vector<OnlineVerificationPublicKey> trusted_public_keys =
		expected.trusted_public_keys.empty() ? OVKeyOverride::get() : expected.trusted_public_keys;
	if (trusted_public_keys.empty()) {
		return policy;
	}
	policy.public_keys.clear();
	policy.allowed_key_ids.clear();
	for (const OnlineVerificationPublicKey& public_key : trusted_public_keys) {
		policy.public_keys.push_back(
			license::os::SignaturePublicKey(public_key.key_id, public_key.public_key_der, public_key.bits));
		policy.allowed_key_ids.push_back(public_key.key_id);
	}
	return policy;
}

bool parse_canonical_payload(const std::string& payload, OnlineAssertionClaims& claims, std::string& error) {
	if (payload.empty() || payload[payload.size() - 1] != '\n' || payload.find('\r') != std::string::npos) {
		error = "online assertion payload is not canonical";
		return false;
	}

	std::string issued_at;
	std::string expires_at;
	std::string cache_until;
	std::string revocation_seq;
	const license::signed_token::FieldSpec fields[] = {
		{"purpose", &claims.purpose},
		{"version", &claims.version},
		{"alg", &claims.algorithm},
		{"key-id", &claims.key_id},
		{"project", &claims.project},
		{"feature", &claims.feature},
		{"license-fingerprint", &claims.license_fingerprint},
		{"device-hash", &claims.device_hash},
		{"nonce", &claims.nonce},
		{"status", &claims.status},
		{"issued-at", &issued_at},
		{"expires-at", &expires_at},
		{"cache-until", &cache_until},
		{"revocation-seq", &revocation_seq},
	};

	if (!license::signed_token::parse_fields_in_order(payload, fields, sizeof(fields) / sizeof(fields[0]),
													  "online assertion", true, error)) {
		return false;
	}
	if (!license::signed_token::parse_uint64(issued_at, claims.issued_at) ||
		!license::signed_token::parse_uint64(expires_at, claims.expires_at) ||
		!license::signed_token::parse_uint64(cache_until, claims.cache_until) ||
		!license::signed_token::parse_uint64(revocation_seq, claims.revocation_seq)) {
		error = "online assertion integer field malformed";
		return false;
	}
	return true;
}

bool validate_claims(const OnlineAssertionClaims& claims, const OnlineVerificationExpected& expected,
					 std::string& error, LCC_EVENT_TYPE& failure_event, bool& used_cache) {
	used_cache = false;
	failure_event = LICENSE_ONLINE_ASSERTION_INVALID;
	const uint64_t now =
		expected.now_epoch_seconds == 0 ? license::signed_token::now_epoch_seconds() : expected.now_epoch_seconds;

	if (claims.purpose != kPurpose || claims.version != kVersion ||
		claims.algorithm != license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256) {
		error = "online assertion metadata mismatch";
		return false;
	}
	if (claims.status != "ok" && claims.status != "denied") {
		error = "online assertion status unsupported";
		return false;
	}
	if (claims.status == "denied") {
		error = "online assertion denied entitlement";
		failure_event = LICENSE_ONLINE_VERIFICATION_FAILED;
		return false;
	}
	if (claims.project != expected.project || claims.feature != expected.feature ||
		claims.license_fingerprint != expected.license_fingerprint || claims.device_hash != expected.device_hash) {
		error = "online assertion request binding mismatch";
		return false;
	}
	if (!is_ascii_hex(claims.license_fingerprint, LCC_API_ONLINE_LICENSE_FINGERPRINT_SIZE) ||
		!is_ascii_hex(claims.nonce, LCC_API_ONLINE_NONCE_SIZE)) {
		error = "online assertion hex field malformed";
		return false;
	}
	if (!claims.device_hash.empty() &&
		!is_ascii_hex(claims.device_hash, LCC_API_ONLINE_DEVICE_HASH_SIZE)) {
		error = "online assertion device hash malformed";
		return false;
	}
	if (claims.issued_at > now + kIssuedAtFutureSkewSeconds || claims.expires_at < claims.issued_at ||
		claims.cache_until < claims.expires_at) {
		error = "online assertion time window malformed";
		return false;
	}
	if (claims.cache_until - claims.issued_at > expected.max_cache_seconds) {
		error = "online assertion cache window exceeds maximum";
		return false;
	}
	if (claims.revocation_seq < expected.min_revocation_seq) {
		error = "online assertion revocation sequence is below minimum";
		return false;
	}
	if (claims.nonce != expected.nonce) {
		if (expected.allow_cache && claims.cache_until >= now) {
			used_cache = true;
			return true;
		}
		error = "online assertion request binding mismatch";
		return false;
	}
	if (claims.expires_at >= now) {
		return true;
	}
	if (expected.allow_cache && claims.cache_until >= now) {
		used_cache = true;
		return true;
	}
	error = expected.allow_cache ? "online assertion cache expired" : "online assertion expired";
	failure_event = expected.allow_cache ? LICENSE_ONLINE_CACHE_EXPIRED : LICENSE_ONLINE_ASSERTION_INVALID;
	return false;
}

bool copy_public_request_field(char* out, const size_t out_size, const std::string& value) {
	if (value.size() >= out_size) {
		return false;
	}
	license::mstrlcpy(out, value.c_str(), out_size);
	return true;
}

const char* callback_status_name(const LCC_ONLINE_CALLBACK_STATUS status) {
	switch (status) {
		case LCC_ONLINE_CB_OK:
			return "ok";
		case LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE:
			return "transport unavailable";
		case LCC_ONLINE_CB_TIMEOUT:
			return "timeout";
		case LCC_ONLINE_CB_BUFFER_TOO_SMALL:
			return "buffer too small";
		case LCC_ONLINE_CB_HOST_DECLINED:
			return "host declined";
		case LCC_ONLINE_CB_MALFORMED_RESPONSE:
			return "malformed response";
		default:
			return "unknown callback status";
	}
}

LCC_EVENT_TYPE event_for_callback_status(const LCC_ONLINE_CALLBACK_STATUS status) {
	switch (status) {
		case LCC_ONLINE_CB_BUFFER_TOO_SMALL:
		case LCC_ONLINE_CB_MALFORMED_RESPONSE:
			return LICENSE_ONLINE_ASSERTION_INVALID;
		case LCC_ONLINE_CB_OK:
			return LICENSE_OK;
		default:
			return LICENSE_ONLINE_VERIFICATION_FAILED;
	}
}

OnlineVerificationResult failure_result(const OnlineVerificationRequest& request, const LCC_EVENT_TYPE event_type,
										const std::string& detail) {
	OnlineVerificationResult result;
	result.policy = request.policy;
	result.accepted = false;
	result.event_type = event_type;
	result.severity = SVRT_ERROR;
	result.license_reference = kReference;
	result.detail = detail;
	return result;
}

}  // namespace

bool OnlineVerificationResult::failed() const {
	return event_type != LICENSE_OK;
}

OnlinePolicy to_internal_policy(const LCC_ONLINE_POLICY policy) {
	switch (policy) {
		case LCC_ONLINE_DISABLED:
			return OnlinePolicy::Disabled;
		case LCC_ONLINE_REQUIRE:
			return OnlinePolicy::Require;
		default:
			return OnlinePolicy::Require;
	}
}

std::string generate_nonce() {
	std::vector<uint8_t> bytes(32);
	if (::getSecureRandomBytes(bytes.data(), bytes.size()) != FUNC_RET_OK) {
		return std::string();
	}
	return license::os::signature_sha256_hex(bytes);
}

std::string build_canonical_assertion_payload(const OnlineAssertionClaims& claims) {
	using license::signed_token::append_claim_line;
	using license::signed_token::append_uint_claim_line;
	std::ostringstream out;
	if (!append_claim_line(out, "purpose", claims.purpose) || !append_claim_line(out, "version", claims.version) ||
		!append_claim_line(out, "alg", claims.algorithm) || !append_claim_line(out, "key-id", claims.key_id) ||
		!append_claim_line(out, "project", claims.project) || !append_claim_line(out, "feature", claims.feature) ||
		!append_claim_line(out, "license-fingerprint", claims.license_fingerprint) ||
		!append_claim_line(out, "device-hash", claims.device_hash) ||
		!append_claim_line(out, "nonce", claims.nonce) || !append_claim_line(out, "status", claims.status) ||
		!append_uint_claim_line(out, "issued-at", claims.issued_at) ||
		!append_uint_claim_line(out, "expires-at", claims.expires_at) ||
		!append_uint_claim_line(out, "cache-until", claims.cache_until) ||
		!append_uint_claim_line(out, "revocation-seq", claims.revocation_seq)) {
		return std::string();
	}
	return out.str();
}

std::string build_assertion_envelope(const std::string& payload, const std::string& signature_base64) {
	return license::signed_token::build_envelope(kEnvelopePrefix, payload, signature_base64);
}

bool verify_assertion_envelope(const std::string& assertion, const OnlineVerificationExpected& expected,
							   OnlineAssertionClaims* claims_out, std::string& error,
							   LCC_EVENT_TYPE& failure_event, bool& used_cache) {
	failure_event = LICENSE_ONLINE_ASSERTION_INVALID;
	used_cache = false;

	std::string payload_b64;
	std::string signature_b64;
	if (!license::signed_token::split_envelope(assertion, kEnvelopePrefix, "online assertion", payload_b64,
											   signature_b64, error)) {
		return false;
	}
	const std::vector<uint8_t> payload = license::unbase64(payload_b64);
	const std::vector<uint8_t> signature = license::unbase64(signature_b64);
	if (payload.empty() || signature.empty()) {
		error = "online assertion decoded payload or signature is empty";
		return false;
	}
	const std::string payload_text(payload.begin(), payload.end());
	if (!license::signed_token::verify_payload_signature(
			payload, signature, payload_text, license::os::LCC_ONLINE_ASSERTION_SIGNATURE_VERSION,
			signature_policy_for_expected(expected), "online assertion", error)) {
		return false;
	}

	OnlineAssertionClaims claims;
	if (!parse_canonical_payload(payload_text, claims, error)) {
		return false;
	}
	if (!validate_claims(claims, expected, error, failure_event, used_cache)) {
		return false;
	}
	if (claims_out != nullptr) {
		*claims_out = claims;
	}
	return true;
}

OnlineVerificationResult evaluate(const OnlineVerificationRequest& request) {
	OnlineVerificationResult result;
	result.policy = request.policy;
	if (request.policy == OnlinePolicy::Disabled) {
		return result;
	}
	if (request.online_check == nullptr) {
		return failure_result(request, LICENSE_ONLINE_REQUIRED, "online callback is not configured");
	}

	const std::string nonce = generate_nonce();
	if (nonce.empty()) {
		return failure_result(request, LICENSE_ONLINE_VERIFICATION_FAILED, "online nonce generation failed");
	}
	LccOnlineRequest public_request{};
	public_request.size = sizeof(public_request);
	public_request.version = LCC_ONLINE_REQUEST_VERSION;
	public_request.policy = LCC_ONLINE_REQUIRE;
	public_request.flags = request.flags;
	public_request.timeout_ms = request.timeout_ms;
	public_request.client_hardening = request.client_hardening;
	if (!copy_public_request_field(public_request.project, sizeof(public_request.project), request.project) ||
		!copy_public_request_field(public_request.feature, sizeof(public_request.feature), request.feature) ||
		!copy_public_request_field(public_request.license_fingerprint,
								   sizeof(public_request.license_fingerprint), request.license_fingerprint) ||
		!copy_public_request_field(public_request.device_hash, sizeof(public_request.device_hash),
								   request.device_hash) ||
		!copy_public_request_field(public_request.nonce, sizeof(public_request.nonce), nonce)) {
		return failure_result(request, LICENSE_ONLINE_VERIFICATION_FAILED, "online request field exceeds API buffer");
	}

	char assertion[LCC_API_ONLINE_ASSERTION_SIZE + 1] = {};
	size_t assertion_size = sizeof(assertion);
	LCC_ONLINE_CALLBACK_STATUS status = LCC_ONLINE_CB_MALFORMED_RESPONSE;
	try {
		status = request.online_check(request.online_user_data, &public_request, assertion, &assertion_size);
		result.callback_invoked = true;
	} catch (const std::exception& ex) {
		return failure_result(request, LICENSE_ONLINE_VERIFICATION_FAILED, ex.what());
	} catch (...) {
		return failure_result(request, LICENSE_ONLINE_VERIFICATION_FAILED, "online callback threw");
	}
	assertion[sizeof(assertion) - 1] = '\0';

	if (status != LCC_ONLINE_CB_OK) {
		return failure_result(request, event_for_callback_status(status),
							  std::string("online callback returned ") + callback_status_name(status));
	}
	if (assertion_size > sizeof(assertion)) {
		return failure_result(request, LICENSE_ONLINE_ASSERTION_INVALID, "online assertion size is invalid");
	}
	const size_t assertion_len = license::mstrnlen_s(assertion, sizeof(assertion));
	if (assertion_len == sizeof(assertion) || assertion_len == 0) {
		return failure_result(request, LICENSE_ONLINE_ASSERTION_INVALID, "online assertion is empty or unterminated");
	}

	OnlineVerificationExpected expected;
	expected.project = request.project;
	expected.feature = request.feature;
	expected.license_fingerprint = request.license_fingerprint;
	expected.device_hash = request.device_hash;
	expected.nonce = nonce;
	expected.now_epoch_seconds = request.now_epoch_seconds;
	expected.allow_cache = false;
	expected.min_revocation_seq = (std::max)(
		current_revocation_floor(request.project, request.feature, request.license_fingerprint),
		request.minimum_revocation_seq);

	std::string error;
	LCC_EVENT_TYPE failure_event = LICENSE_ONLINE_ASSERTION_INVALID;
	bool used_cache = false;
	OnlineAssertionClaims claims;
	if (!verify_assertion_envelope(std::string(assertion, assertion_len), expected, &claims, error, failure_event,
								   used_cache)) {
		return failure_result(request, failure_event, error);
	}
	advance_revocation_floor(request.project, request.feature, request.license_fingerprint, claims.revocation_seq);
	result.accepted = true;
	result.used_cache = used_cache;
	result.accepted_revocation_seq = claims.revocation_seq;
	return result;
}

OnlineVerificationResult notify_release(const OnlineVerificationRequest& request) {
	OnlineVerificationResult result;
	result.policy = request.policy;
	if (request.online_check == nullptr) {
		return failure_result(request, LICENSE_ONLINE_REQUIRED, "online callback is not configured");
	}

	const std::string nonce = generate_nonce();
	if (nonce.empty()) {
		return failure_result(request, LICENSE_ONLINE_VERIFICATION_FAILED, "online nonce generation failed");
	}
	LccOnlineRequest public_request{};
	public_request.size = sizeof(public_request);
	public_request.version = LCC_ONLINE_REQUEST_VERSION;
	public_request.policy = LCC_ONLINE_REQUIRE;
	public_request.flags = request.flags;
	public_request.timeout_ms = request.timeout_ms;
	public_request.client_hardening = request.client_hardening;
	if (!copy_public_request_field(public_request.project, sizeof(public_request.project), request.project) ||
		!copy_public_request_field(public_request.feature, sizeof(public_request.feature), request.feature) ||
		!copy_public_request_field(public_request.license_fingerprint,
								   sizeof(public_request.license_fingerprint), request.license_fingerprint) ||
		!copy_public_request_field(public_request.device_hash, sizeof(public_request.device_hash),
								   request.device_hash) ||
		!copy_public_request_field(public_request.nonce, sizeof(public_request.nonce), nonce)) {
		return failure_result(request, LICENSE_ONLINE_VERIFICATION_FAILED, "online request field exceeds API buffer");
	}

	// The release response carries no assertion (the server just frees the seat), so we discard the
	// output buffer and never run verify_assertion_envelope. A held seat lapses server-side on
	// heartbeat timeout regardless, so a declined/failed callback here is advisory, not a denial.
	char assertion[LCC_API_ONLINE_ASSERTION_SIZE + 1] = {};
	size_t assertion_size = sizeof(assertion);
	LCC_ONLINE_CALLBACK_STATUS status = LCC_ONLINE_CB_MALFORMED_RESPONSE;
	try {
		status = request.online_check(request.online_user_data, &public_request, assertion, &assertion_size);
		result.callback_invoked = true;
	} catch (const std::exception& ex) {
		return failure_result(request, LICENSE_ONLINE_VERIFICATION_FAILED, ex.what());
	} catch (...) {
		return failure_result(request, LICENSE_ONLINE_VERIFICATION_FAILED, "online release callback threw");
	}
	assertion[sizeof(assertion) - 1] = '\0';  // defensive, mirrors evaluate(); the body is then discarded

	if (status != LCC_ONLINE_CB_OK) {
		return failure_result(request, event_for_callback_status(status),
							  std::string("online release callback returned ") + callback_status_name(status));
	}
	result.accepted = true;
	return result;
}

void append_audit_event(const OnlineVerificationResult& result, EventRegistry& event_registry) {
	if (!result.failed()) {
		return;
	}
	event_registry.addEventWithSeverity(result.severity, result.event_type, result.license_reference.c_str(),
										result.detail.c_str());
}

void set_trusted_public_keys_for_tests(const std::vector<OnlineVerificationPublicKey>& public_keys) {
	OVKeyOverride::set(public_keys);
}

void set_revocation_floor(const std::string& project, const std::string& feature,
						  const std::string& license_fingerprint, const uint64_t revocation_seq) {
	advance_revocation_floor(project, feature, license_fingerprint, revocation_seq);
}

uint64_t revocation_floor(const std::string& project, const std::string& feature,
						  const std::string& license_fingerprint) {
	return current_revocation_floor(project, feature, license_fingerprint);
}

void reset_revocation_floors_for_tests() {
	std::lock_guard<std::mutex> lock(revocation_floors_mutex());
	revocation_floors().clear();
}

uint64_t revocation_floor_for_tests(const std::string& project, const std::string& feature,
									const std::string& license_fingerprint) {
	return revocation_floor(project, feature, license_fingerprint);
}

}  // namespace online_verification
}  // namespace license
