#ifndef LICENSECC_DEVICE_IDENTITY_H_
#define LICENSECC_DEVICE_IDENTITY_H_

#include <stddef.h>
#include <stdint.h>
#ifndef __cplusplus
#include <stdbool.h>
#endif

#include "datatypes.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum LCC_DEVICE_RESULT {
    LCC_DEVICE_OK = 0,
    LCC_DEVICE_INVALID_ARGUMENT = 1,
    LCC_DEVICE_UNSUPPORTED_VERSION = 2,
    LCC_DEVICE_BUFFER_TOO_SMALL = 3,
    LCC_DEVICE_PROVIDER_UNAVAILABLE = 4,
    LCC_DEVICE_HARDWARE_UNAVAILABLE = 5,
    LCC_DEVICE_ACCESS_DENIED = 6,
    LCC_DEVICE_KEY_NOT_FOUND = 7,
    LCC_DEVICE_KEY_CORRUPT = 8,
    LCC_DEVICE_KEY_LOST = 9,
    LCC_DEVICE_UNSUPPORTED_ALGORITHM = 10,
    LCC_DEVICE_SIGN_FAILED = 11,
    LCC_DEVICE_IO_ERROR = 12,
    LCC_DEVICE_BUSY = 13,
    LCC_DEVICE_POLICY_VIOLATION = 14,
    LCC_DEVICE_INTERNAL_ERROR = 255
} LCC_DEVICE_RESULT;

typedef enum LCC_DEVICE_BACKEND {
    LCC_DEVICE_BACKEND_AUTO = 0,
    LCC_DEVICE_BACKEND_WINDOWS_TPM = 1,
    LCC_DEVICE_BACKEND_TPM2_OPENSSL = 2,
    LCC_DEVICE_BACKEND_SOFTWARE_TEST = 255
} LCC_DEVICE_BACKEND;

typedef enum LCC_DEVICE_POLICY {
    LCC_DEVICE_POLICY_UNSPECIFIED = 0,
    LCC_DEVICE_POLICY_HARDWARE_REQUIRED = 1,
    LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT = 2
} LCC_DEVICE_POLICY;

typedef enum LCC_DEVICE_SCOPE {
    LCC_DEVICE_SCOPE_UNSPECIFIED = 0,
    LCC_DEVICE_SCOPE_USER = 1,
    LCC_DEVICE_SCOPE_MACHINE = 2
} LCC_DEVICE_SCOPE;

typedef enum LCC_DEVICE_ASSURANCE {
    LCC_DEVICE_ASSURANCE_UNKNOWN = 0,
    LCC_DEVICE_ASSURANCE_SOFTWARE = 1,
    LCC_DEVICE_ASSURANCE_REPORTED_HARDWARE = 2
} LCC_DEVICE_ASSURANCE;

typedef enum LCC_DEVICE_PROOF_AUDIENCE {
    LCC_DEVICE_PROOF_AUDIENCE_UNSPECIFIED = 0,
    LCC_DEVICE_PROOF_AUDIENCE_VERIFY = 1,
    LCC_DEVICE_PROOF_AUDIENCE_LEASE = 2,
    LCC_DEVICE_PROOF_AUDIENCE_SEAT = 3
} LCC_DEVICE_PROOF_AUDIENCE;

#define LCC_DEVICE_IDENTITY_VERSION 1u
#define LCC_DEVICE_PROOF_VERSION 1u
#define LCC_DEVICE_OPEN_CREATE_IF_MISSING 0x00000001u
#define LCC_DEVICE_APPLICATION_ID_MAX 128u
#define LCC_DEVICE_PROVIDER_NAME_MAX 63u
#define LCC_DEVICE_ALGORITHM_MAX 31u
#define LCC_DEVICE_KEY_ID_MAX 71u
#define LCC_DEVICE_SIGNATURE_BASE64_MAX 88u

typedef struct LccDeviceIdentityOptions {
    uint32_t size;
    uint32_t version;
    uint32_t backend; /* LCC_DEVICE_BACKEND */
    uint32_t policy;  /* LCC_DEVICE_POLICY */
    uint32_t scope;   /* LCC_DEVICE_SCOPE */
    uint32_t flags;
    uint32_t lock_timeout_ms;
    uint32_t reserved;
    char application_id[LCC_DEVICE_APPLICATION_ID_MAX + 1];
    char project[LCC_API_ONLINE_PROJECT_SIZE + 1];
    char storage_directory[LCC_API_PATH_SIZE];
} LccDeviceIdentityOptions;

typedef struct LccDeviceIdentityMetadata {
    uint32_t size;
    uint32_t version;
    uint32_t backend;   /* LCC_DEVICE_BACKEND */
    uint32_t scope;     /* LCC_DEVICE_SCOPE */
    uint32_t assurance; /* LCC_DEVICE_ASSURANCE */
    uint32_t reserved;
    char provider[LCC_DEVICE_PROVIDER_NAME_MAX + 1];
    char algorithm[LCC_DEVICE_ALGORITHM_MAX + 1];
    char device_key_id[LCC_DEVICE_KEY_ID_MAX + 1];
} LccDeviceIdentityMetadata;

typedef struct LccDeviceProofInput {
    uint32_t size;
    uint32_t version;
    uint32_t audience; /* LCC_DEVICE_PROOF_AUDIENCE */
    uint32_t client_hardening;
    uint64_t request_timestamp;
    char project[LCC_API_ONLINE_PROJECT_SIZE + 1];
    char feature[LCC_API_FEATURE_NAME_SIZE + 1];
    char license_fingerprint[65];
    char device_hash[65];
    char nonce[65];
} LccDeviceProofInput;

typedef struct LccDeviceProof {
    uint32_t size;
    uint32_t version;
    uint32_t request_signature_version;
    uint32_t reserved;
    uint64_t request_timestamp;
    char device_key_id[LCC_DEVICE_KEY_ID_MAX + 1];
    char request_signature_algorithm[LCC_DEVICE_ALGORITHM_MAX + 1];
    char request_signature[LCC_DEVICE_SIGNATURE_BASE64_MAX + 1];
} LccDeviceProof;

void lcc_init_device_identity_options(LccDeviceIdentityOptions*);
void lcc_init_device_identity_metadata(LccDeviceIdentityMetadata*);
void lcc_init_device_proof_input(LccDeviceProofInput*);
void lcc_init_device_proof(LccDeviceProof*);

LCC_DEVICE_RESULT lcc_device_identity_open(const LccDeviceIdentityOptions*, LccDeviceIdentity** out);
LCC_DEVICE_RESULT lcc_device_identity_get_metadata(LccDeviceIdentity*, LccDeviceIdentityMetadata* out);
LCC_DEVICE_RESULT lcc_device_identity_get_public_spki(LccDeviceIdentity*, uint8_t* out, size_t* inout_size);
LCC_DEVICE_RESULT lcc_device_identity_build_request_proof_v1(
    LccDeviceIdentity*, const LccDeviceProofInput*, LccDeviceProof* out);
LCC_DEVICE_RESULT lcc_device_identity_delete_key(
    const LccDeviceIdentityOptions*, const char* expected_device_key_id);

/* Handles are process-local. On POSIX, fork before opening one, or close it
 * before fork and reopen in the child. close/delete require exclusive owner
 * coordination with all operations on the same handle or namespace. */
void lcc_device_identity_close(LccDeviceIdentity*);
const char* lcc_device_strerror(LCC_DEVICE_RESULT);

#ifdef __cplusplus
}
#endif

#endif
