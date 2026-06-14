#ifndef LICENSECC_CONFIG_ATTESTATION_HPP_
#define LICENSECC_CONFIG_ATTESTATION_HPP_

#include <stdint.h>
#include <string>
#include <vector>

namespace license {
namespace config_attestation {

enum class ConfigVerifyFailure {
	None,
	Envelope,
	Signature,
	Metadata,
	Binding,
	HashMismatch,
	Expired,
	Rollback
};

struct ConfigAttestationClaims {
	std::string purpose;
	std::string version;
	std::string algorithm;
	std::string key_id;
	std::string project;
	std::string feature;
	std::string license_fingerprint;
	std::string device_hash;
	std::string config_id;
	uint64_t config_seq = 0;
	std::string config_hash;
	uint64_t issued_at = 0;
	uint64_t expires_at = 0;
};

struct ConfigAttestationPublicKey {
	std::string key_id;
	std::vector<uint8_t> public_key_der;
	unsigned int bits = 0;
};

struct ConfigAttestationExpected {
	std::string project;
	std::string feature;
	std::string license_fingerprint;
	std::string device_hash;
	std::vector<uint8_t> config_bytes;
	uint64_t now_epoch_seconds = 0;
	uint64_t min_config_seq = 0;
	std::vector<ConfigAttestationPublicKey> trusted_public_keys;
};

std::string build_canonical_config_payload(const ConfigAttestationClaims& claims);
std::string build_config_envelope(const std::string& payload, const std::string& signature_base64);
bool verify_config_envelope(const std::string& token, const ConfigAttestationExpected& expected,
							ConfigAttestationClaims* claims_out, std::string& error,
							ConfigVerifyFailure& failure);

void set_trusted_public_keys_for_tests(const std::vector<ConfigAttestationPublicKey>& public_keys);

}  // namespace config_attestation
}  // namespace license

#endif
