#include <licensecc/device_identity.h>

#include <stddef.h>
#include <stdint.h>

int lcc_device_identity_c_header_smoke(void) {
	LccDeviceIdentityOptions options;
	LccDeviceIdentityMetadata metadata;
	LccDeviceIdentity* identity = NULL;
	lcc_init_device_identity_options(&options);
	lcc_init_device_identity_metadata(&metadata);
	return identity == NULL && options.size == sizeof(options) && metadata.size == sizeof(metadata) ? 0 : 1;
}
