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
#include "../signed_token/SignedToken.hpp"

namespace license {
namespace config_attestation {
namespace {

using CAKeyOverride = license::signed_token::TrustedKeyOverride<ConfigAttestationPublicKey>;

const char kEnvelopePrefix[] = "lcccfg1";
const char kPurpose[] = "licensecc-config-attestation";
const char kVersion[] = "1";
const unsigned int kConfigSignatureVersion = 9002U;
const uint64_t kIssuedAtFutureSkewSeconds = 300;

license::os::SignatureVerificationPolicy config_signature_policy(const ConfigAttestationExpected& expected) {
	license::os::SignatureVerificationPolicy policy;
	policy.license_version = kConfigSignatureVersion;
	policy.allowed_algorithms.push_back(license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256);
	policy.min_public_key_bits = 3072;
	std::vector<ConfigAttestationPublicKey> trusted = expected.trusted_public_keys;
	if (trusted.empty()) {
		trusted = CAKeyOverride::get();
	}
	for (const ConfigAttestationPublicKey& public_key : trusted) {
		policy.public_keys.push_back(
			license::os::SignaturePublicKey(public_key.key_id, public_key.public_key_der, public_key.bits));
		policy.allowed_key_ids.push_back(public_key.key_id);
	}
	if (policy.public_keys.empty()) {
		const std::vector<license::os::SignaturePublicKey> embedded =
			license::os::config_attestation_public_key_ring();
		for (const license::os::SignaturePublicKey& public_key : embedded) {
			policy.public_keys.push_back(public_key);
			policy.allowed_key_ids.push_back(public_key.key_id);
		}
		license::os::append_config_attestation_retired_key_ids(policy.retired_key_ids);
	}
	return policy;
}

bool parse_canonical_payload(const std::string& payload, ConfigAttestationClaims& claims, std::string& error) {
	if (payload.empty() || payload[payload.size() - 1] != '\n' || payload.find('\r') != std::string::npos) {
		error = "config token payload is not canonical";
		return false;
	}
	std::string config_seq;
	std::string issued_at;
	std::string expires_at;
	const license::signed_token::FieldSpec fields[] = {
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
	if (!license::signed_token::parse_fields_in_order(payload, fields, sizeof(fields) / sizeof(fields[0]),
													  "config token", false, error)) {
		return false;
	}
	if (!license::signed_token::parse_uint64(config_seq, claims.config_seq) ||
		!license::signed_token::parse_uint64(issued_at, claims.issued_at) ||
		!license::signed_token::parse_uint64(expires_at, claims.expires_at)) {
		error = "config token integer field malformed";
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
	const uint64_t now =
		expected.now_epoch_seconds == 0 ? license::signed_token::now_epoch_seconds() : expected.now_epoch_seconds;
	if (claims.issued_at > now + kIssuedAtFutureSkewSeconds) {
		failure = ConfigVerifyFailure::Expired;
		error = "config token issued in the future";
		return false;
	}
	if (claims.expires_at == 0) {
		// Never-expiring config tokens are rejected: every config token must carry a finite
		// expiry, matching the online assertion path (which has no never-expires concept).
		failure = ConfigVerifyFailure::Expired;
		error = "config token has no expiry";
		return false;
	}
	if (claims.expires_at < claims.issued_at || claims.expires_at < now) {
		failure = ConfigVerifyFailure::Expired;
		error = "config token expired";
		return false;
	}
	if (claims.config_seq < expected.min_config_seq) {
		failure = ConfigVerifyFailure::Rollback;
		error = "config token sequence is below the minimum";
		return false;
	}
	return true;
}

}  // namespace

std::string build_canonical_config_payload(const ConfigAttestationClaims& claims) {
	using license::signed_token::append_claim_line;
	using license::signed_token::append_uint_claim_line;
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
	return license::signed_token::build_envelope(kEnvelopePrefix, payload, signature_base64);
}

bool verify_config_envelope(const std::string& token, const ConfigAttestationExpected& expected,
							ConfigAttestationClaims* claims_out, std::string& error, ConfigVerifyFailure& failure) {
	failure = ConfigVerifyFailure::None;
	std::string payload_b64;
	std::string signature_b64;
	if (!license::signed_token::split_envelope(token, kEnvelopePrefix, "config token", payload_b64, signature_b64,
											   error)) {
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
	if (!license::signed_token::verify_payload_signature(payload, signature, payload_text, kConfigSignatureVersion,
														 config_signature_policy(expected), "config token", error)) {
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
	CAKeyOverride::set(public_keys);
}

}  // namespace config_attestation
}  // namespace license
