#include "bound_checkpoint_platform.hpp"
#include "bound_encoding.hpp"
#include "bound_http.hpp"
#include "p256_crypto.hpp"
namespace license {
namespace device_identity {
bool bound_checkpoint_namespace(const BoundCheckpointNamespace& options, std::string& out) noexcept {
	try {
		BoundHttpOrigin origin;
		if (!parse_bound_http_origin(options.endpoint_origin, origin) || options.application_id.empty() ||
			options.application_id.size() > 128 || !bound_encoding::name(options.project) ||
			!bound_encoding::name(options.feature, 15))
			return false;
		for (unsigned char c : options.application_id)
			if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-' ||
				  c == '_'))
				return false;
		std::string framed = "licensecc-checkpoint-v1:user:";
		for (const auto* value :
			 {&options.application_id, &options.endpoint_origin, &options.issuer, &options.lease_audience,
			  &options.proof_audience, &options.project, &options.feature}) {
			if (value->size() > 1024 || !bound_encoding::utf8_text(*value)) return false;
			framed += std::to_string(value->size()) + ":" + *value;
		}
		P256Digest digest;
		if (!sha256(reinterpret_cast<const std::uint8_t*>(framed.data()), framed.size(), digest)) return false;
		auto hash = lowercase_hex(digest.data(), digest.size());
		out.swap(hash);
		return true;
	} catch (...) {
		return false;
	}
}
}  // namespace device_identity
}  // namespace license
