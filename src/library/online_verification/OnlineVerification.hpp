#ifndef LICENSECC_ONLINE_VERIFICATION_HPP_
#define LICENSECC_ONLINE_VERIFICATION_HPP_

#include <licensecc/datatypes.h>

#include <stdint.h>
#include <string>
#include <vector>

namespace license {
class EventRegistry;

namespace online_verification {

enum class OnlinePolicy {
	Disabled,
	Require
};

struct OnlineAssertionClaims {
	std::string purpose;
	std::string version;
	std::string algorithm;
	std::string key_id;
	std::string project;
	std::string feature;
	std::string license_fingerprint;
	std::string device_hash;
	std::string nonce;
	std::string status;
	uint64_t issued_at = 0;
	uint64_t expires_at = 0;
	uint64_t cache_until = 0;
	uint64_t revocation_seq = 0;
};

struct OnlineVerificationPublicKey {
	std::string key_id;
	std::vector<uint8_t> public_key_der;
	unsigned int bits = 0;
};

struct OnlineVerificationExpected {
	std::string project;
	std::string feature;
	std::string license_fingerprint;
	std::string device_hash;
	std::string nonce;
	uint64_t now_epoch_seconds = 0;
	bool allow_cache = false;
	uint64_t max_cache_seconds = 86400;
	uint64_t min_revocation_seq = 0;
	std::vector<OnlineVerificationPublicKey> trusted_public_keys;
};

struct OnlineVerificationRequest {
	OnlinePolicy policy = OnlinePolicy::Disabled;
	uint32_t flags = 0;
	uint32_t timeout_ms = LCC_ONLINE_DEFAULT_TIMEOUT_MS;
	LCC_ONLINE_CHECK online_check = nullptr;
	void* online_user_data = nullptr;
	std::string project;
	std::string feature;
	std::string license_fingerprint;
	std::string device_hash;
	uint64_t now_epoch_seconds = 0;
	uint64_t minimum_revocation_seq = 0;
};

struct OnlineVerificationResult {
	OnlinePolicy policy = OnlinePolicy::Disabled;
	bool accepted = true;
	bool callback_invoked = false;
	bool used_cache = false;
	uint64_t accepted_revocation_seq = 0;
	LCC_EVENT_TYPE event_type = LICENSE_OK;
	LCC_SEVERITY severity = SVRT_INFO;
	std::string license_reference;
	std::string detail;

	bool failed() const;
};

OnlinePolicy to_internal_policy(LCC_ONLINE_POLICY policy);
std::string generate_nonce();
std::string build_canonical_assertion_payload(const OnlineAssertionClaims& claims);
std::string build_assertion_envelope(const std::string& payload, const std::string& signature_base64);
bool verify_assertion_envelope(const std::string& assertion, const OnlineVerificationExpected& expected,
							   OnlineAssertionClaims* claims_out, std::string& error,
							   LCC_EVENT_TYPE& failure_event, bool& used_cache);
OnlineVerificationResult evaluate(const OnlineVerificationRequest& request);
void append_audit_event(const OnlineVerificationResult& result, EventRegistry& event_registry);
void set_trusted_public_keys_for_tests(const std::vector<OnlineVerificationPublicKey>& public_keys);
void set_revocation_floor(const std::string& project, const std::string& feature,
						  const std::string& license_fingerprint, uint64_t revocation_seq);
uint64_t revocation_floor(const std::string& project, const std::string& feature,
						  const std::string& license_fingerprint);
void reset_revocation_floors_for_tests();
uint64_t revocation_floor_for_tests(const std::string& project, const std::string& feature,
									const std::string& license_fingerprint);

}  // namespace online_verification
}  // namespace license

#endif
