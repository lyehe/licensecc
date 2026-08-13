#ifndef LICENSECC_DEVICE_IDENTITY_H_
#define LICENSECC_DEVICE_IDENTITY_H_

#include <stddef.h>
#include <stdint.h>
#ifndef __cplusplus
#include <stdbool.h>
#endif

#include "datatypes.h"

/**
 * \defgroup deviceidentity Device identity and request proofs
 * \brief Process-local device-key handles and signed request-proof creation.
 *
 * The device-identity API owns a provider-backed P-256 signing key and produces
 * request proofs for the online licensing service. Call the ``lcc_init_*``
 * helper for every versioned structure before filling its fields. Handles are
 * process-local and must be closed with ::lcc_device_identity_close.
 * @{
 */

#ifdef __cplusplus
extern "C" {
#endif

/** Result code returned by every fallible device-identity operation. */
typedef enum LCC_DEVICE_RESULT {
	/** Operation completed successfully. */
	LCC_DEVICE_OK = 0,
	/** A pointer, field, flag, or buffer length is invalid. */
	LCC_DEVICE_INVALID_ARGUMENT = 1,
	/** A versioned input structure uses an unsupported version. */
	LCC_DEVICE_UNSUPPORTED_VERSION = 2,
	/** The output buffer is too small; the required size is returned when applicable. */
	LCC_DEVICE_BUFFER_TOO_SMALL = 3,
	/** The requested provider was not built or cannot be loaded. */
	LCC_DEVICE_PROVIDER_UNAVAILABLE = 4,
	/** The provider is present but its hardware is unavailable. */
	LCC_DEVICE_HARDWARE_UNAVAILABLE = 5,
	/** The caller cannot access the provider or its key storage. */
	LCC_DEVICE_ACCESS_DENIED = 6,
	/** No key exists and create-if-missing was not requested. */
	LCC_DEVICE_KEY_NOT_FOUND = 7,
	/** Stored key material is malformed or fails validation. */
	LCC_DEVICE_KEY_CORRUPT = 8,
	/** Provider metadata exists but the backing key can no longer be loaded. */
	LCC_DEVICE_KEY_LOST = 9,
	/** The provider cannot supply the required P-256 signing algorithm. */
	LCC_DEVICE_UNSUPPORTED_ALGORITHM = 10,
	/** The provider failed to sign an otherwise valid request. */
	LCC_DEVICE_SIGN_FAILED = 11,
	/** A persistent-storage operation failed. */
	LCC_DEVICE_IO_ERROR = 12,
	/** The provider or key namespace did not become available before the deadline. */
	LCC_DEVICE_BUSY = 13,
	/** The requested backend, scope, or fallback violates the selected policy. */
	LCC_DEVICE_POLICY_VIOLATION = 14,
	/** An unexpected internal failure occurred. */
	LCC_DEVICE_INTERNAL_ERROR = 255
} LCC_DEVICE_RESULT;

/** Provider selection for ::LccDeviceIdentityOptions. */
typedef enum LCC_DEVICE_BACKEND {
	/** Select the supported platform provider without silently using the test provider. */
	LCC_DEVICE_BACKEND_AUTO = 0,
	/** Windows Platform Crypto Provider backed by the system TPM. */
	LCC_DEVICE_BACKEND_WINDOWS_TPM = 1,
	/** Linux OpenSSL 3 provider backed by TPM2 key-reference storage. */
	LCC_DEVICE_BACKEND_TPM2_OPENSSL = 2,
	/** Explicit process-local software provider; available only in test builds. */
	LCC_DEVICE_BACKEND_SOFTWARE_TEST = 255
} LCC_DEVICE_BACKEND;

/** Assurance policy applied while choosing and opening a provider. */
typedef enum LCC_DEVICE_POLICY {
	/** No valid policy was supplied. */
	LCC_DEVICE_POLICY_UNSPECIFIED = 0,
	/** Require a supported hardware-backed provider. */
	LCC_DEVICE_POLICY_HARDWARE_REQUIRED = 1,
	/** Permit the software test provider only when explicitly selected. */
	LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT = 2
} LCC_DEVICE_POLICY;

/** Persistence scope for the provider key. */
typedef enum LCC_DEVICE_SCOPE {
	/** No valid scope was supplied. */
	LCC_DEVICE_SCOPE_UNSPECIFIED = 0,
	/** Persist the key for the current operating-system user. */
	LCC_DEVICE_SCOPE_USER = 1,
	/** Persist the key for the machine when the provider supports it. */
	LCC_DEVICE_SCOPE_MACHINE = 2
} LCC_DEVICE_SCOPE;

/** Assurance reported by an opened provider. */
typedef enum LCC_DEVICE_ASSURANCE {
	/** The provider could not report an assurance class. */
	LCC_DEVICE_ASSURANCE_UNKNOWN = 0,
	/** The key is software-backed and intended only for explicit test use. */
	LCC_DEVICE_ASSURANCE_SOFTWARE = 1,
	/** The provider reports hardware-backed key storage. */
	LCC_DEVICE_ASSURANCE_REPORTED_HARDWARE = 2
} LCC_DEVICE_ASSURANCE;

/** Server operation to which a request proof is bound. */
typedef enum LCC_DEVICE_PROOF_AUDIENCE {
	/** No valid audience was supplied. */
	LCC_DEVICE_PROOF_AUDIENCE_UNSPECIFIED = 0,
	/** Bind the proof to online verification. */
	LCC_DEVICE_PROOF_AUDIENCE_VERIFY = 1,
	/** Bind the proof to lease activation or renewal. */
	LCC_DEVICE_PROOF_AUDIENCE_LEASE = 2,
	/** Bind the proof to floating-seat operations. */
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

/** Versioned input used to select, create, and open a device key. */
typedef struct LccDeviceIdentityOptions {
	/** Structure size; initialized by ::lcc_init_device_identity_options. */
	uint32_t size;
	/** Structure version; set to ::LCC_DEVICE_IDENTITY_VERSION. */
	uint32_t version;
	/** One of ::LCC_DEVICE_BACKEND. */
	uint32_t backend; /* LCC_DEVICE_BACKEND */
	/** One of ::LCC_DEVICE_POLICY. */
	uint32_t policy; /* LCC_DEVICE_POLICY */
	/** One of ::LCC_DEVICE_SCOPE. */
	uint32_t scope; /* LCC_DEVICE_SCOPE */
	/** Bitwise device-open flags, currently ::LCC_DEVICE_OPEN_CREATE_IF_MISSING. */
	uint32_t flags;
	/** Maximum namespace-lock wait in milliseconds. */
	uint32_t lock_timeout_ms;
	/** Reserved for future versions; leave zero. */
	uint32_t reserved;
	/** Stable application namespace, NUL-terminated and at most ::LCC_DEVICE_APPLICATION_ID_MAX bytes. */
	char application_id[LCC_DEVICE_APPLICATION_ID_MAX + 1];
	/** Licensing project bound into provider storage and proof metadata. */
	char project[LCC_API_ONLINE_PROJECT_SIZE + 1];
	/** Optional provider storage directory; provider-specific defaults apply when empty. */
	char storage_directory[LCC_API_PATH_SIZE];
} LccDeviceIdentityOptions;

/** Metadata describing an opened provider key. */
typedef struct LccDeviceIdentityMetadata {
	/** Structure size; initialized by ::lcc_init_device_identity_metadata. */
	uint32_t size;
	/** Structure version; set to ::LCC_DEVICE_IDENTITY_VERSION. */
	uint32_t version;
	/** Selected ::LCC_DEVICE_BACKEND. */
	uint32_t backend; /* LCC_DEVICE_BACKEND */
	/** Effective ::LCC_DEVICE_SCOPE. */
	uint32_t scope; /* LCC_DEVICE_SCOPE */
	/** Reported ::LCC_DEVICE_ASSURANCE. */
	uint32_t assurance; /* LCC_DEVICE_ASSURANCE */
	/** Reserved for future versions; leave zero. */
	uint32_t reserved;
	/** NUL-terminated provider name. */
	char provider[LCC_DEVICE_PROVIDER_NAME_MAX + 1];
	/** NUL-terminated signing algorithm identifier. */
	char algorithm[LCC_DEVICE_ALGORITHM_MAX + 1];
	/** Canonical ``sha256:<hex>`` identifier of the public key. */
	char device_key_id[LCC_DEVICE_KEY_ID_MAX + 1];
} LccDeviceIdentityMetadata;

/** Canonical fields signed into a version-1 request proof. */
typedef struct LccDeviceProofInput {
	/** Structure size; initialized by ::lcc_init_device_proof_input. */
	uint32_t size;
	/** Structure version; set to ::LCC_DEVICE_PROOF_VERSION. */
	uint32_t version;
	/** One of ::LCC_DEVICE_PROOF_AUDIENCE. */
	uint32_t audience; /* LCC_DEVICE_PROOF_AUDIENCE */
	/** Client-hardening bitset reported to the server. */
	uint32_t client_hardening;
	/** Request creation time as Unix seconds. */
	uint64_t request_timestamp;
	/** Licensing project expected by the target operation. */
	char project[LCC_API_ONLINE_PROJECT_SIZE + 1];
	/** Feature name expected by the target operation. */
	char feature[LCC_API_FEATURE_NAME_SIZE + 1];
	/** Lowercase 64-hex license fingerprint. */
	char license_fingerprint[65];
	/** Optional lowercase 64-hex device hash, or an empty string. */
	char device_hash[65];
	/** Lowercase 64-hex single-use server challenge. */
	char nonce[65];
} LccDeviceProofInput;

/** Provider-produced proof fields sent with an online request. */
typedef struct LccDeviceProof {
	/** Structure size; initialized by ::lcc_init_device_proof. */
	uint32_t size;
	/** Structure version; set to ::LCC_DEVICE_PROOF_VERSION. */
	uint32_t version;
	/** Canonical request-signature payload version. */
	uint32_t request_signature_version;
	/** Reserved for future versions; leave zero. */
	uint32_t reserved;
	/** Request timestamp copied from ::LccDeviceProofInput. */
	uint64_t request_timestamp;
	/** Canonical ``sha256:<hex>`` signing-key identifier. */
	char device_key_id[LCC_DEVICE_KEY_ID_MAX + 1];
	/** Request-signature algorithm identifier. */
	char request_signature_algorithm[LCC_DEVICE_ALGORITHM_MAX + 1];
	/** Canonical Base64 P1363 signature. */
	char request_signature[LCC_DEVICE_SIGNATURE_BASE64_MAX + 1];
} LccDeviceProof;

/** Initialize device-key options to versioned, fail-closed defaults. */
void lcc_init_device_identity_options(LccDeviceIdentityOptions*);
/** Initialize a metadata output structure. */
void lcc_init_device_identity_metadata(LccDeviceIdentityMetadata*);
/** Initialize a request-proof input structure. */
void lcc_init_device_proof_input(LccDeviceProofInput*);
/** Initialize a request-proof output structure. */
void lcc_init_device_proof(LccDeviceProof*);

/** Open or create a provider key according to ``options``. */
LCC_DEVICE_RESULT lcc_device_identity_open(const LccDeviceIdentityOptions*, LccDeviceIdentity** out);
/** Read provider, assurance, algorithm, and key-id metadata from an open handle. */
LCC_DEVICE_RESULT lcc_device_identity_get_metadata(LccDeviceIdentity*, LccDeviceIdentityMetadata* out);
/** Export the exact DER SubjectPublicKeyInfo for the provider key. */
LCC_DEVICE_RESULT lcc_device_identity_get_public_spki(LccDeviceIdentity*, uint8_t* out, size_t* inout_size);
/** Sign the canonical version-1 request-proof payload. */
LCC_DEVICE_RESULT lcc_device_identity_build_request_proof_v1(LccDeviceIdentity*, const LccDeviceProofInput*,
														 LccDeviceProof* out);
/** Delete the exact key identified by ``expected_device_key_id``. */
LCC_DEVICE_RESULT lcc_device_identity_delete_key(const LccDeviceIdentityOptions*, const char* expected_device_key_id);

/**
 * Close a process-local device-key handle.
 *
 * On POSIX, fork before opening a handle, or close it before ``fork`` and
 * reopen it in the child. Close and delete require exclusive owner
 * coordination with operations on the same handle or provider namespace.
 */
void lcc_device_identity_close(LccDeviceIdentity*);
/** Return a stable English description for a device result code. */
const char* lcc_device_strerror(LCC_DEVICE_RESULT);

#ifdef __cplusplus
}
#endif

/** @} */

#endif
