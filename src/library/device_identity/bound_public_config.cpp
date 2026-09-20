#include "bound_public.hpp"
#include "bound_encoding.hpp"
#include <cstring>
#include <type_traits>

namespace license {
namespace device_identity {
namespace {
template <std::size_t N>
bool copy(const char (&in)[N], std::string& out) {
	const auto end = static_cast<const char*>(std::memchr(in, 0, N));
	if (!end) return false;
	out.assign(in, end);
	return true;
}
bool application(const std::string& value) {
	if (value.empty() || !((value[0] >= 'a' && value[0] <= 'z') || (value[0] >= '0' && value[0] <= '9'))) return false;
	for (unsigned char c : value)
		if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')) return false;
	return true;
}
}  // namespace
LCC_BOUND_RESULT validate_bound_public_options(const LccDeviceBoundOptions* in, BoundPublicConfig& out) noexcept {
	try {
		const auto structure = bound_public_structure(in);
		if (structure != LCC_BOUND_OK) return structure;
		if (in->reserved || !in->trust_key_count || in->trust_key_count > LCC_DEVICE_BOUND_TRUST_MAX)
			return LCC_BOUND_INVALID_ARGUMENT;
		BoundPublicConfig c;
		auto& e = c.enrollment;
		auto& s = c.storage;
		if (!copy(in->application_id, s.application_id) || !copy(in->endpoint_origin, e.endpoint_origin) ||
			!copy(in->portal_authorization_url, e.portal_authorization_url) || !copy(in->issuer, e.session.issuer) ||
			!copy(in->lease_audience, e.session.lease_audience) ||
			!copy(in->proof_audience, e.session.proof_audience) || !copy(in->project, e.session.project) ||
			!copy(in->feature, e.session.feature) || !copy(in->client_id, e.client_id) ||
			!copy(in->device_label, e.device_label) || !copy(in->callback_path, c.callback_path))
			return LCC_BOUND_INVALID_ARGUMENT;
		BoundHttpOrigin origin;
		std::string label;
		if (!application(s.application_id) || !parse_bound_http_origin(e.endpoint_origin, origin) ||
			!valid_bound_portal_url(e.portal_authorization_url) || !bound_encoding::utf8_text(e.session.issuer) ||
			!bound_encoding::utf8_text(e.session.lease_audience) ||
			!bound_encoding::utf8_text(e.session.proof_audience) || !bound_encoding::name(e.session.project) ||
			!bound_encoding::name(e.session.feature, 15) || !bound_encoding::name(e.client_id) ||
			!normalize_bound_device_label(e.device_label, label) || c.callback_path.find("//") != std::string::npos ||
			!bound_encoding::loopback_uri("http://127.0.0.1:49152" + c.callback_path))
			return LCC_BOUND_INVALID_ARGUMENT;
		e.device_label = std::move(label);
		s.endpoint_origin = e.endpoint_origin;
		s.issuer = e.session.issuer;
		s.lease_audience = e.session.lease_audience;
		s.proof_audience = e.session.proof_audience;
		s.project = e.session.project;
		s.feature = e.session.feature;
		bool active = false;
		for (unsigned i = 0; i < in->trust_key_count; ++i) {
			const auto& key = in->trust_keys[i];
			if (!key.spki_size || key.spki_size > LCC_DEVICE_BOUND_SPKI_MAX || key.retired > 1)
				return LCC_BOUND_INVALID_ARGUMENT;
			c.trust.push_back({{key.spki, key.spki + key.spki_size}, key.retired != 0});
			active = active || !key.retired;
		}
		if (!active || !validate_bound_lease_trust(c.trust)) return LCC_BOUND_INVALID_ARGUMENT;
		out = std::move(c);
		return LCC_BOUND_OK;
	} catch (...) {
		return LCC_BOUND_INTERNAL_ERROR;
	}
}
}  // namespace device_identity
}  // namespace license

static_assert(std::is_standard_layout<LccDeviceBoundOptions>::value, "public options must have C layout");
static_assert(sizeof(LccDeviceBoundTrustKey) == 520, "public trust key layout");
static_assert(offsetof(LccDeviceBoundOptions, application_id) == 16, "public options prefix");
static_assert(offsetof(LccDeviceBoundOutcome, effective_time) == 24, "public outcome prefix");

extern "C" {
void lcc_init_device_bound_options(LccDeviceBoundOptions* out) {
	if (!out) return;
	std::memset(out, 0, sizeof(*out));
	out->size = sizeof(*out);
	out->version = LCC_DEVICE_BOUND_VERSION;
	std::strcpy(out->callback_path, "/callback");
}
void lcc_init_device_bound_view(LccDeviceBoundView* out) {
	if (!out) return;
	std::memset(out, 0, sizeof(*out));
	out->size = sizeof(*out);
	out->version = LCC_DEVICE_BOUND_VERSION;
}
void lcc_init_device_bound_outcome(LccDeviceBoundOutcome* out) {
	if (!out) return;
	std::memset(out, 0, sizeof(*out));
	out->size = sizeof(*out);
	out->version = LCC_DEVICE_BOUND_VERSION;
}
}
