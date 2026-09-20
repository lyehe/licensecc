#include "bound_possession.hpp"
#include "bound_encoding.hpp"
#include "device_identity_handle.hpp"
#include "../os/os.h"

namespace license {
namespace device_identity {
LCC_DEVICE_RESULT prove_bound_key_possession(LccDeviceIdentity* identity, const std::string& project,
											 const std::string& expected_key_id,
											 const std::string& lease_sha256) noexcept {
	try {
		if (!identity || !identity->provider || !bound_encoding::name(project) ||
			!bound_encoding::key_id_valid(expected_key_id) || !bound_encoding::hex_digest(lease_sha256))
			return LCC_DEVICE_INVALID_ARGUMENT;
		if (identity->project != project || identity->device_key_id != expected_key_id)
			return LCC_DEVICE_POLICY_VIOLATION;
		const auto derived = device_key_id(identity->spki);
		if (derived.empty()) return LCC_DEVICE_INTERNAL_ERROR;
		if (derived != expected_key_id) return LCC_DEVICE_POLICY_VIOLATION;
		SensitiveArray<32> nonce, digest;
		SensitiveArray<64> signature;
		if (getSecureRandomBytes(nonce.value.data(), nonce.value.size()) != FUNC_RET_OK)
			return LCC_DEVICE_INTERNAL_ERROR;
		// Every variable text field has a delimiter-free canonical alphabet;
		// the fixed-width nonce and final LF end the transcript. This purpose is distinct
		// from every server request proof and never exposes a signing oracle.
		const auto prefix = std::string("licensecc:local-possession:v1\n") + project + '\n' + expected_key_id + '\n' +
							lease_sha256 + '\n';
		SensitiveVector transcript;
		transcript.value.reserve(prefix.size() + nonce.value.size() + 1);
		transcript.value.insert(transcript.value.end(), prefix.begin(), prefix.end());
		transcript.value.insert(transcript.value.end(), nonce.value.begin(), nonce.value.end());
		transcript.value.push_back('\n');
		if (!sha256(transcript.value.data(), transcript.value.size(), digest.value)) return LCC_DEVICE_INTERNAL_ERROR;
		LCC_DEVICE_RESULT result;
		{
			std::lock_guard<std::mutex> lock(identity->signing_mutex);
			result = identity->provider->sign_digest(digest.value, signature.value);
		}
		if (result != LCC_DEVICE_OK) return result;
		return verify_p256_p1363(identity->spki, digest.value, signature.value) ? LCC_DEVICE_OK
																				: LCC_DEVICE_SIGN_FAILED;
	} catch (...) {
		return LCC_DEVICE_INTERNAL_ERROR;
	}
}
}  // namespace device_identity
}  // namespace license
