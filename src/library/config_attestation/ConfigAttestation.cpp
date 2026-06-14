#include "ConfigAttestation.hpp"

#include <mutex>
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

}  // namespace

std::string build_canonical_config_payload(const ConfigAttestationClaims&) {
	return std::string();
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
