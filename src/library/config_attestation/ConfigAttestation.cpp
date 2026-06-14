#include "ConfigAttestation.hpp"

#include <cstdint>
#include <ctime>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

#include "../base/base64.h"
#include "../os/os.h"
#include "../os/signature_verifier.hpp"

namespace license {
namespace config_attestation {
namespace {

std::vector<ConfigAttestationPublicKey>& trusted_public_keys_override() {
	static std::vector<ConfigAttestationPublicKey> public_keys;
	return public_keys;
}

std::mutex& trusted_public_keys_override_mutex() {
	static std::mutex mutex;
	return mutex;
}

bool value_has_line_breaks_or_equals(const std::string& value) {
	return value.find('\n') != std::string::npos || value.find('\r') != std::string::npos ||
		   value.find('=') != std::string::npos;
}

bool append_claim_line(std::ostringstream& out, const char* key, const std::string& value) {
	if (value_has_line_breaks_or_equals(value)) {
		return false;
	}
	out << key << '=' << value << '\n';
	return true;
}

bool append_uint_claim_line(std::ostringstream& out, const char* key, const uint64_t value) {
	out << key << '=' << value << '\n';
	return true;
}

const char kEnvelopePrefix[] = "lcccfg1";
const char kPurpose[] = "licensecc-config-attestation";
const char kVersion[] = "1";
const unsigned int kConfigSignatureVersion = 9002U;
const uint64_t kIssuedAtFutureSkewSeconds = 300;

uint64_t now_epoch_seconds() {
	return static_cast<uint64_t>(time(nullptr));
}

std::vector<ConfigAttestationPublicKey> current_trusted_public_keys() {
	std::lock_guard<std::mutex> lock(trusted_public_keys_override_mutex());
	return trusted_public_keys_override();
}

bool parse_uint64(const std::string& value, uint64_t& out) {
	if (value.empty()) {
		return false;
	}
	uint64_t result = 0;
	for (const unsigned char ch : value) {
		if (ch < '0' || ch > '9') {
			return false;
		}
		const uint64_t digit = static_cast<uint64_t>(ch - '0');
		if (result > (UINT64_MAX - digit) / 10U) {
			return false;
		}
		result = result * 10U + digit;
	}
	out = result;
	return true;
}

bool extract_preverify_field(const std::string& payload, const char* key, std::string& out) {
	const std::string prefix = std::string(key) + "=";
	size_t pos = 0;
	while (pos < payload.size()) {
		const size_t next = payload.find('\n', pos);
		if (next == std::string::npos) {
			return false;
		}
		const std::string line = payload.substr(pos, next - pos);
		if (line.find(prefix) == 0) {
			out = line.substr(prefix.size());
			return !out.empty();
		}
		pos = next + 1;
	}
	return false;
}

license::os::SignatureVerificationPolicy config_signature_policy(const ConfigAttestationExpected& expected) {
	license::os::SignatureVerificationPolicy policy;
	policy.license_version = kConfigSignatureVersion;
	policy.allowed_algorithms.push_back(license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256);
	policy.min_public_key_bits = 0;
	const std::vector<ConfigAttestationPublicKey> trusted =
		expected.trusted_public_keys.empty() ? current_trusted_public_keys() : expected.trusted_public_keys;
	for (const ConfigAttestationPublicKey& public_key : trusted) {
		policy.public_keys.push_back(
			license::os::SignaturePublicKey(public_key.key_id, public_key.public_key_der, public_key.bits));
		policy.allowed_key_ids.push_back(public_key.key_id);
	}
	return policy;
}

bool split_envelope(const std::string& token, std::string& payload_b64, std::string& signature_b64,
					std::string& error) {
	const size_t first_dot = token.find('.');
	if (first_dot == std::string::npos) {
		error = "config token missing payload";
		return false;
	}
	const size_t second_dot = token.find('.', first_dot + 1);
	if (second_dot == std::string::npos || token.find('.', second_dot + 1) != std::string::npos) {
		error = "config token envelope malformed";
		return false;
	}
	if (token.substr(0, first_dot) != kEnvelopePrefix) {
		error = "config token prefix mismatch";
		return false;
	}
	payload_b64 = token.substr(first_dot + 1, second_dot - first_dot - 1);
	signature_b64 = token.substr(second_dot + 1);
	if (!license::is_canonical_base64(payload_b64, false) || !license::is_canonical_base64(signature_b64, false)) {
		error = "config token base64 is not canonical";
		return false;
	}
	return true;
}

bool parse_canonical_payload(const std::string& payload, ConfigAttestationClaims& claims, std::string& error) {
	if (payload.empty() || payload[payload.size() - 1] != '\n' || payload.find('\r') != std::string::npos) {
		error = "config token payload is not canonical";
		return false;
	}
	std::string config_seq;
	std::string issued_at;
	std::string expires_at;
	const struct {
		const char* key;
		std::string* value;
	} fields[] = {
		{"purpose", &claims.purpose},
		{"version", &claims.version},
		{"alg", &claims.algorithm},
		{"key-id", &claims.key_id},
		{"project", &claims.project},
		{"feature", &claims.feature},
		{"license-fingerprint", &claims.license_fingerprint},
		{"device-hash", &claims.device_hash},
		{"config-id", &claims.config_id},
		{"config-seq", &config_seq},
		{"config-hash", &claims.config_hash},
		{"issued-at", &issued_at},
		{"expires-at", &expires_at},
	};
	size_t pos = 0;
	for (const auto& field : fields) {
		const size_t next = payload.find('\n', pos);
		if (next == std::string::npos) {
			error = std::string("config token missing field ") + field.key;
			return false;
		}
		const std::string line = payload.substr(pos, next - pos);
		const std::string prefix = std::string(field.key) + "=";
		if (line.find(prefix) != 0) {
			error = std::string("config token expected field ") + field.key;
			return false;
		}
		*field.value = line.substr(prefix.size());
		pos = next + 1;
	}
	if (pos != payload.size()) {
		error = "config token has unknown trailing fields";
		return false;
	}
	if (!parse_uint64(config_seq, claims.config_seq) || !parse_uint64(issued_at, claims.issued_at) ||
		!parse_uint64(expires_at, claims.expires_at)) {
		error = "config token integer field malformed";
		return false;
	}
	return true;
}

bool verify_payload_signature(const std::vector<uint8_t>& payload, const std::vector<uint8_t>& signature,
							  const std::string& payload_text, const ConfigAttestationExpected& expected,
							  std::string& error) {
	std::string algorithm;
	std::string key_id;
	if (!extract_preverify_field(payload_text, "alg", algorithm) ||
		!extract_preverify_field(payload_text, "key-id", key_id)) {
		error = "config token missing signature metadata";
		return false;
	}
	license::os::SignatureVerificationRequest request;
	request.payload = payload;
	request.signature = signature;
	request.declared_algorithm = algorithm;
	request.key_id = key_id;
	request.license_version = kConfigSignatureVersion;
	request.policy = config_signature_policy(expected);
	if (license::os::verify_signature(request) != FUNC_RET_OK) {
		error = "config token signature verification failed";
		return false;
	}
	return true;
}

bool validate_claims(const ConfigAttestationClaims& claims, const ConfigAttestationExpected& expected,
					 std::string& error, ConfigVerifyFailure& failure) {
	if (claims.purpose != kPurpose || claims.version != kVersion ||
		claims.algorithm != license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256) {
		failure = ConfigVerifyFailure::Metadata;
		error = "config token metadata mismatch";
		return false;
	}
	if (claims.project != expected.project || claims.feature != expected.feature ||
		claims.license_fingerprint != expected.license_fingerprint || claims.device_hash != expected.device_hash) {
		failure = ConfigVerifyFailure::Binding;
		error = "config token request binding mismatch";
		return false;
	}
	const std::string expected_config_hash =
		std::string("sha256:") + license::os::signature_sha256_hex(expected.config_bytes);
	if (claims.config_hash != expected_config_hash) {
		failure = ConfigVerifyFailure::HashMismatch;
		error = "config token hash does not match config bytes";
		return false;
	}
	const uint64_t now = expected.now_epoch_seconds == 0 ? now_epoch_seconds() : expected.now_epoch_seconds;
	if (claims.issued_at > now + kIssuedAtFutureSkewSeconds) {
		failure = ConfigVerifyFailure::Expired;
		error = "config token issued in the future";
		return false;
	}
	if (claims.expires_at != 0 && (claims.expires_at < claims.issued_at || claims.expires_at < now)) {
		failure = ConfigVerifyFailure::Expired;
		error = "config token expired";
		return false;
	}
	return true;
}

}  // namespace

std::string build_canonical_config_payload(const ConfigAttestationClaims& claims) {
	std::ostringstream out;
	if (!append_claim_line(out, "purpose", claims.purpose) || !append_claim_line(out, "version", claims.version) ||
		!append_claim_line(out, "alg", claims.algorithm) || !append_claim_line(out, "key-id", claims.key_id) ||
		!append_claim_line(out, "project", claims.project) || !append_claim_line(out, "feature", claims.feature) ||
		!append_claim_line(out, "license-fingerprint", claims.license_fingerprint) ||
		!append_claim_line(out, "device-hash", claims.device_hash) ||
		!append_claim_line(out, "config-id", claims.config_id) ||
		!append_uint_claim_line(out, "config-seq", claims.config_seq) ||
		!append_claim_line(out, "config-hash", claims.config_hash) ||
		!append_uint_claim_line(out, "issued-at", claims.issued_at) ||
		!append_uint_claim_line(out, "expires-at", claims.expires_at)) {
		return std::string();
	}
	return out.str();
}

std::string build_config_envelope(const std::string& payload, const std::string& signature_base64) {
	const std::string payload_b64 = license::base64(payload.data(), payload.size(), 0);
	return std::string(kEnvelopePrefix) + "." + payload_b64 + "." + signature_base64;
}

bool verify_config_envelope(const std::string& token, const ConfigAttestationExpected& expected,
							ConfigAttestationClaims* claims_out, std::string& error, ConfigVerifyFailure& failure) {
	failure = ConfigVerifyFailure::None;
	std::string payload_b64;
	std::string signature_b64;
	if (!split_envelope(token, payload_b64, signature_b64, error)) {
		failure = ConfigVerifyFailure::Envelope;
		return false;
	}
	const std::vector<uint8_t> payload = license::unbase64(payload_b64);
	const std::vector<uint8_t> signature = license::unbase64(signature_b64);
	if (payload.empty() || signature.empty()) {
		failure = ConfigVerifyFailure::Envelope;
		error = "config token decoded payload or signature is empty";
		return false;
	}
	const std::string payload_text(payload.begin(), payload.end());
	if (!verify_payload_signature(payload, signature, payload_text, expected, error)) {
		failure = ConfigVerifyFailure::Signature;
		return false;
	}
	ConfigAttestationClaims claims;
	if (!parse_canonical_payload(payload_text, claims, error)) {
		failure = ConfigVerifyFailure::Envelope;
		return false;
	}
	if (!validate_claims(claims, expected, error, failure)) {
		return false;
	}
	if (claims_out != nullptr) {
		*claims_out = claims;
	}
	return true;
}

void set_trusted_public_keys_for_tests(const std::vector<ConfigAttestationPublicKey>& public_keys) {
	std::lock_guard<std::mutex> lock(trusted_public_keys_override_mutex());
	trusted_public_keys_override() = public_keys;
}

}  // namespace config_attestation
}  // namespace license
