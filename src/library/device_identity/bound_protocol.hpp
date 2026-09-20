#ifndef LICENSECC_DEVICE_IDENTITY_BOUND_PROTOCOL_HPP_
#define LICENSECC_DEVICE_IDENTITY_BOUND_PROTOCOL_HPP_

#include <cstdint>
#include <string>
#include <vector>
#include "p256_crypto.hpp"
#include <licensecc/device_identity.h>

namespace license {
namespace device_identity {

// Internal typed wire boundary. These encoders do not establish trust in an
// audience, callback, challenge, or lease. The enrollment owner pins those.
struct BoundProofInput {
	std::string audience;
	std::string path;
	std::string operation_id;
	std::string body_sha256;
	std::string challenge_id;
	std::string nonce;
	std::uint64_t expires_at = 0;
};
struct EnrollmentComparisonInput {
	std::string attempt_handle;
	std::string client_id;
	std::string project;
	std::string redirect_uri;
	std::string state;
	std::string code_challenge;
};
struct BoundExchangeInput {
	std::string attempt_handle, code, code_verifier, redirect_uri, operation_id;
};
void wipe_bound_exchange(BoundExchangeInput&) noexcept;
// Bounded native storage for approval/exchange secrets; not persistent state.
class BoundExchangeSecret {
public:
	BoundExchangeSecret() = default;
	explicit BoundExchangeSecret(const BoundExchangeInput&);
	~BoundExchangeSecret() { wipe_bound_exchange(value); }
	BoundExchangeSecret(const BoundExchangeSecret&) = delete;
	BoundExchangeSecret& operator=(const BoundExchangeSecret&) = delete;
	BoundExchangeInput value;
};
struct BoundRenewInput {
	std::string binding_id;
	std::uint64_t generation = 0;
	std::string operation_id;
};
struct BoundChallenge {
	std::string challenge_id, nonce;
	std::uint64_t expires_at = 0;
};
// From locally pinned application/enrollment configuration, not a server proof.
struct BoundLocalContext {
	std::string project, audience;
};
struct BoundPreparedProof {
	BoundProofInput proof;
	std::string operation_digest;
};
struct BoundSignedProof {
	BoundPreparedProof prepared;
	std::string key_id, signature;	// canonical unpadded base64url, low-S P1363
};

// Exchange bodies contain reversible code/PKCE material. Scratch and output
// transcript buffers are explicitly wiped. The caller owns input lifetimes.
bool bound_operation_body_v1(const BoundExchangeInput&, SensitiveVector& out) noexcept;
bool bound_operation_body_v1(const BoundRenewInput&, SensitiveVector& out) noexcept;
bool bound_operation_digest_input_v1(const BoundExchangeInput&, const std::string& key_id,
									 SensitiveVector& out) noexcept;
bool bound_operation_digest_input_v1(const BoundRenewInput&, const std::string& key_id, SensitiveVector& out) noexcept;
LCC_DEVICE_RESULT prepare_bound_proof_v2(const BoundExchangeInput&, const BoundChallenge&, const std::string& audience,
										 const std::string& key_id, BoundPreparedProof& out) noexcept;
LCC_DEVICE_RESULT prepare_bound_proof_v2(const BoundRenewInput&, const BoundChallenge&, const std::string& audience,
										 const std::string& key_id, BoundPreparedProof& out) noexcept;
// Internal typed signing entrypoints. Never accept a caller-supplied key ID,
// method, path or body hash. Output remains unchanged on any failure.
LCC_DEVICE_RESULT sign_bound_proof_v2(LccDeviceIdentity*, const BoundLocalContext&, const BoundExchangeInput&,
									  const BoundChallenge&, BoundSignedProof& out) noexcept;
LCC_DEVICE_RESULT sign_bound_proof_v2(LccDeviceIdentity*, const BoundLocalContext&, const BoundRenewInput&,
									  const BoundChallenge&, BoundSignedProof& out) noexcept;

// key_id must come from the local provider, never the server response.
// On failure outputs remain unchanged. No signing or browser launch occurs.
bool bound_proof_input_v2(const BoundProofInput&, const std::string& key_id, std::vector<std::uint8_t>& out) noexcept;
bool enrollment_comparison_input_v1(const EnrollmentComparisonInput&, const std::string& key_id,
									std::vector<std::uint8_t>& out) noexcept;
bool enrollment_comparison_code_v1(const EnrollmentComparisonInput&, const std::string& key_id,
								   std::string& out) noexcept;

}  // namespace device_identity
}  // namespace license
#endif
