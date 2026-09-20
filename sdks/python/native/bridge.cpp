#include <licensecc/device_bound.h>
#include <licensecc/feature_session.h>
#include <cstddef>
#include <cstdint>

// Read-only ABI probe. Python checks every size/offset before passing structures.
// This DLL adds no lifecycle, provider policy, transport or authority state.
extern "C" std::uint32_t lcc_device_bound_bridge_layout(std::uint32_t index) {
#define FIELD(type, field) \
	static_cast<std::uint32_t>(offsetof(type, field)), static_cast<std::uint32_t>(sizeof(((type*)nullptr)->field))
	static constexpr std::uint32_t layout[]{1,
											sizeof(void*),
											LCC_DEVICE_BOUND_VERSION,
											LCC_DEVICE_BOUND_TRUST_MAX,
											LCC_DEVICE_BOUND_SPKI_MAX,
											sizeof(LccDeviceBoundTrustKey),
											alignof(LccDeviceBoundTrustKey),
											FIELD(LccDeviceBoundTrustKey, spki_size),
											FIELD(LccDeviceBoundTrustKey, retired),
											FIELD(LccDeviceBoundTrustKey, spki),
											sizeof(LccDeviceBoundOptions),
											alignof(LccDeviceBoundOptions),
											FIELD(LccDeviceBoundOptions, size),
											FIELD(LccDeviceBoundOptions, version),
											FIELD(LccDeviceBoundOptions, trust_key_count),
											FIELD(LccDeviceBoundOptions, reserved),
											FIELD(LccDeviceBoundOptions, application_id),
											FIELD(LccDeviceBoundOptions, endpoint_origin),
											FIELD(LccDeviceBoundOptions, portal_authorization_url),
											FIELD(LccDeviceBoundOptions, issuer),
											FIELD(LccDeviceBoundOptions, lease_audience),
											FIELD(LccDeviceBoundOptions, proof_audience),
											FIELD(LccDeviceBoundOptions, project),
											FIELD(LccDeviceBoundOptions, feature),
											FIELD(LccDeviceBoundOptions, client_id),
											FIELD(LccDeviceBoundOptions, device_label),
											FIELD(LccDeviceBoundOptions, callback_path),
											FIELD(LccDeviceBoundOptions, trust_keys),
											sizeof(LccDeviceBoundView),
											alignof(LccDeviceBoundView),
											FIELD(LccDeviceBoundView, size),
											FIELD(LccDeviceBoundView, version),
											FIELD(LccDeviceBoundView, expires_at),
											FIELD(LccDeviceBoundView, comparison_code),
											sizeof(LccDeviceBoundOutcome),
											alignof(LccDeviceBoundOutcome),
											FIELD(LccDeviceBoundOutcome, size),
											FIELD(LccDeviceBoundOutcome, version),
											FIELD(LccDeviceBoundOutcome, provider_result),
											FIELD(LccDeviceBoundOutcome, checkpoint_result),
											FIELD(LccDeviceBoundOutcome, renewal_due),
											FIELD(LccDeviceBoundOutcome, reserved),
											FIELD(LccDeviceBoundOutcome, effective_time)};
#undef FIELD
	return index < sizeof(layout) / sizeof(layout[0]) ? layout[index] : UINT32_MAX;
}

// Independent optional probe: keep the old bridge layout byte-for-byte stable.
extern "C" std::uint32_t lcc_feature_session_bridge_layout(std::uint32_t index) {
#define FEATURE_FIELD(field)                                               \
	static_cast<std::uint32_t>(offsetof(LccFeatureSessionOutcome, field)), \
		static_cast<std::uint32_t>(sizeof(((LccFeatureSessionOutcome*)nullptr)->field))
	static constexpr std::uint32_t layout[]{LCC_FEATURE_SESSION_VERSION,
											sizeof(void*),
											sizeof(LccFeatureSessionOutcome),
											alignof(LccFeatureSessionOutcome),
											FEATURE_FIELD(size),
											FEATURE_FIELD(version),
											FEATURE_FIELD(state),
											FEATURE_FIELD(provider_result),
											FEATURE_FIELD(checkpoint_result),
											FEATURE_FIELD(renewal_due),
											FEATURE_FIELD(reserved),
											FEATURE_FIELD(effective_time),
											FEATURE_FIELD(renew_after),
											FEATURE_FIELD(expires_at)};
#undef FEATURE_FIELD
	return index < sizeof(layout) / sizeof(layout[0]) ? layout[index] : UINT32_MAX;
}
