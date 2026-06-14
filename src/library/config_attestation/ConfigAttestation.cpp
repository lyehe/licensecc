#include "ConfigAttestation.hpp"

#include <mutex>
#include <sstream>
#include <vector>

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

std::string build_config_envelope(const std::string&, const std::string&) {
	return std::string();
}

bool verify_config_envelope(const std::string&, const ConfigAttestationExpected&, ConfigAttestationClaims*,
							std::string& error, ConfigVerifyFailure& failure) {
	failure = ConfigVerifyFailure::Envelope;
	error = "config attestation not implemented";
	return false;
}

void set_trusted_public_keys_for_tests(const std::vector<ConfigAttestationPublicKey>& public_keys) {
	std::lock_guard<std::mutex> lock(trusted_public_keys_override_mutex());
	trusted_public_keys_override() = public_keys;
}

}  // namespace config_attestation
}  // namespace license
