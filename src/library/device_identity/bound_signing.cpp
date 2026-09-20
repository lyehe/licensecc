#include "bound_protocol.hpp"
#include "device_identity_handle.hpp"
#include <algorithm>
#include <mutex>
#include <utility>

namespace license {
namespace device_identity {
namespace {
template <class Input>
LCC_DEVICE_RESULT sign_bound(LccDeviceIdentity* identity, const BoundLocalContext& context, const Input& input,
							 const BoundChallenge& challenge, BoundSignedProof& out) noexcept {
	try {
		if (!identity) return LCC_DEVICE_INVALID_ARGUMENT;
		if (context.project != identity->project) return LCC_DEVICE_POLICY_VIOLATION;
		BoundSignedProof candidate;
		candidate.key_id = identity->device_key_id;
		const auto prepared =
			prepare_bound_proof_v2(input, challenge, context.audience, candidate.key_id, candidate.prepared);
		if (prepared != LCC_DEVICE_OK) return prepared;
		std::vector<std::uint8_t> payload;
		SensitiveArray<32> digest;
		SensitiveArray<64> signature, normalized;
		if (!bound_proof_input_v2(candidate.prepared.proof, candidate.key_id, payload) ||
			!sha256(payload.data(), payload.size(), digest.value))
			return LCC_DEVICE_INTERNAL_ERROR;
		LCC_DEVICE_RESULT result;
		{
			std::lock_guard<std::mutex> lock(identity->signing_mutex);
			result = identity->provider->sign_digest(digest.value, signature.value);
		}
		if (result != LCC_DEVICE_OK) return result;
		if (!normalize_p1363_low_s(signature.value, normalized.value) ||
			!verify_p256_p1363(identity->spki, digest.value, normalized.value))
			return LCC_DEVICE_SIGN_FAILED;
		candidate.signature = encode_canonical_base64(normalized.value.data(), normalized.value.size());
		std::replace(candidate.signature.begin(), candidate.signature.end(), '+', '-');
		std::replace(candidate.signature.begin(), candidate.signature.end(), '/', '_');
		while (!candidate.signature.empty() && candidate.signature.back() == '=') candidate.signature.pop_back();
		if (candidate.signature.size() != 86) return LCC_DEVICE_INTERNAL_ERROR;
		out = std::move(candidate);
		return LCC_DEVICE_OK;
	} catch (...) {
		return LCC_DEVICE_INTERNAL_ERROR;
	}
}
}  // namespace
LCC_DEVICE_RESULT sign_bound_proof_v2(LccDeviceIdentity* identity, const BoundLocalContext& context,
									  const BoundExchangeInput& input, const BoundChallenge& challenge,
									  BoundSignedProof& out) noexcept {
	return sign_bound(identity, context, input, challenge, out);
}
LCC_DEVICE_RESULT sign_bound_proof_v2(LccDeviceIdentity* identity, const BoundLocalContext& context,
									  const BoundRenewInput& input, const BoundChallenge& challenge,
									  BoundSignedProof& out) noexcept {
	return sign_bound(identity, context, input, challenge, out);
}
}  // namespace device_identity
}  // namespace license
