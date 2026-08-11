#include <licensecc/device_identity.h>

#include <stddef.h>
#include <stdint.h>

int lcc_device_identity_c_header_smoke(void) {
    LccDeviceIdentityOptions options;
    LccDeviceIdentityMetadata metadata;
    LccDeviceProofInput input;
    LccDeviceProof proof;
    LccDeviceIdentity* identity = NULL;
    lcc_init_device_identity_options(&options);
    lcc_init_device_identity_metadata(&metadata);
    lcc_init_device_proof_input(&input);
    lcc_init_device_proof(&proof);
    return identity == NULL && options.size == sizeof(options) && metadata.size == sizeof(metadata) &&
                   input.size == sizeof(input) && proof.size == sizeof(proof)
               ? 0
               : 1;
}
