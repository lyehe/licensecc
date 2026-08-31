#include "base/base64.h"
#include "online_verification/OnlineVerification.hpp"
#include "signed_token/SignedToken.hpp"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace {

constexpr std::size_t kMaxInputSize = 16U * 1024U;

void parse_canonical_payload_shape(const std::string& payload) {
	std::string error;
	if (payload.empty() || payload.back() != '\n' || payload.find('\r') != std::string::npos) {
		return;
	}

	license::online_verification::OnlineAssertionClaims claims;
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
		return;
	}
	(void)license::signed_token::parse_uint64(issued_at, claims.issued_at);
	(void)license::signed_token::parse_uint64(expires_at, claims.expires_at);
	(void)license::signed_token::parse_uint64(cache_until, claims.cache_until);
	(void)license::signed_token::parse_uint64(revocation_seq, claims.revocation_seq);
}

void parse_unsigned_payload(const std::string& assertion) {
	std::string payload_base64;
	std::string signature_base64;
	std::string error;
	if (!license::signed_token::split_envelope(assertion, "lccoa1", "online assertion", payload_base64,
											   signature_base64, error)) {
		return;
	}

	const std::vector<std::uint8_t> payload_bytes = license::unbase64(payload_base64);
	if (payload_bytes.empty()) {
		return;
	}
	parse_canonical_payload_shape(std::string(payload_bytes.begin(), payload_bytes.end()));
}

license::online_verification::OnlineVerificationExpected synthetic_expectations() {
	license::online_verification::OnlineVerificationExpected expected;
	expected.project = "SYNTHETIC";
	expected.feature = "EXPORT";
	expected.license_fingerprint = std::string(64, 'a');
	expected.device_hash = std::string(64, 'b');
	expected.nonce = std::string(64, 'c');
	expected.now_epoch_seconds = 1700000000;
	expected.allow_cache = true;
	return expected;
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, const std::size_t size) {
	if (data == nullptr || size == 0 || size > kMaxInputSize) {
		return 0;
	}

	const std::string input(reinterpret_cast<const char*>(data), size);
	parse_canonical_payload_shape(input);
	parse_unsigned_payload(input);

	license::online_verification::OnlineAssertionClaims claims;
	std::string error;
	LCC_EVENT_TYPE failure_event = LICENSE_ONLINE_ASSERTION_INVALID;
	bool used_cache = false;
	const license::online_verification::OnlineVerificationExpected expected = synthetic_expectations();
	(void)license::online_verification::verify_assertion_envelope(input, expected, &claims, error, failure_event,
																  used_cache);
	return 0;
}
