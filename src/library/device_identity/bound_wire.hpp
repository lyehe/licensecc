#ifndef LICENSECC_BOUND_WIRE_HPP_
#define LICENSECC_BOUND_WIRE_HPP_
#include "bound_protocol.hpp"
namespace license {
namespace device_identity {
bool normalize_bound_device_label(const std::string&, std::string& out) noexcept;
enum class BoundWireOperation { renew_challenge, renew, enrollment_challenge, exchange, authorize };
enum class BoundWireKind {
	challenge,
	lease,
	retry,
	authority_denied,
	conflict,
	request_rejected,
	authorization_unavailable,
	registration
};
struct BoundAuthorizationInput {
	std::string client_id, project, public_key_spki, device_label, redirect_uri, state, code_challenge;
};
struct BoundWireResponse {
	BoundWireKind kind = BoundWireKind::request_rejected;
	std::string code, request_id, lease;
	BoundChallenge challenge;
	std::string attempt_handle, authorization_url, comparison_code;
	std::uint64_t authorization_expires_at = 0;
};
bool encode_bound_authorization(const BoundAuthorizationInput&, SensitiveVector& out) noexcept;
bool encode_bound_renew_challenge(const BoundRenewInput&, std::string& out) noexcept;
bool encode_bound_renew_request(const BoundRenewInput&, const BoundSignedProof&, std::string& out) noexcept;
bool encode_bound_exchange_challenge(const BoundExchangeInput&, SensitiveVector& out) noexcept;
bool encode_bound_exchange_request(const BoundExchangeInput&, const BoundSignedProof&, SensitiveVector& out) noexcept;
// Codec only: requires bounded complete HTTP body/status from the transport.
// The native HTTP owner must authenticate/correlate the pinned server context
// before applying a classified denial. A parsed lease still requires session
// signature, identity, operation, time and possession verification. Recovery
// may retain an older request_id; it is tracing metadata, not correlation.
bool decode_bound_device_response(BoundWireOperation, unsigned http_status, const std::string& body,
								  BoundWireResponse& out) noexcept;
}  // namespace device_identity
}  // namespace license
#endif
