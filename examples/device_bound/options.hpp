#ifndef LICENSECC_EXAMPLE_OPTIONS_HPP_
#define LICENSECC_EXAMPLE_OPTIONS_HPP_
#include <licensecc/device_bound.h>
#include "configuration.hpp"
#include <cstring>
namespace example_configuration {
template <std::size_t N, std::size_t M>
void setting(char (&out)[N], const char (&value)[M]) {
	static_assert(M <= N, "configured value exceeds public option capacity");
	std::memcpy(out, value, M);
}
inline LccDeviceBoundOptions options() {
	LccDeviceBoundOptions o;
	lcc_init_device_bound_options(&o);
	setting(o.application_id, configuration::application_id);
	setting(o.endpoint_origin, configuration::endpoint_origin);
	setting(o.portal_authorization_url, configuration::portal_url);
	setting(o.issuer, configuration::issuer);
	setting(o.lease_audience, configuration::lease_audience);
	setting(o.proof_audience, configuration::proof_audience);
	setting(o.project, configuration::project);
	setting(o.feature, configuration::feature);
	setting(o.client_id, configuration::client_id);
	setting(o.device_label, configuration::device_label);
	constexpr auto count = sizeof(configuration::signing_keys) / sizeof(configuration::signing_keys[0]);
	static_assert(count > 0 && count <= LCC_DEVICE_BOUND_TRUST_MAX, "public trust count");
	static_assert(sizeof(configuration::signing_keys[0].bytes) <= LCC_DEVICE_BOUND_SPKI_MAX, "public key size");
	o.trust_key_count = static_cast<uint32_t>(count);
	for (uint32_t i = 0; i < o.trust_key_count; ++i) {
		o.trust_keys[i].spki_size = configuration::signing_keys[i].size;
		std::memcpy(o.trust_keys[i].spki, configuration::signing_keys[i].bytes, configuration::signing_keys[i].size);
		o.trust_keys[i].retired = 0;
	}
	return o;
}
}  // namespace example_configuration
#endif
