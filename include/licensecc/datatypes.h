#ifndef DATATYPES_H_
#define DATATYPES_H_
/** \addtogroup apistruct
 * @{
 */

#ifdef __cplusplus
extern "C" {
#endif

// definition of size_t
#include <stdlib.h>
#include <stdint.h>
#ifndef _MSC_VER
#include <stdbool.h>
#endif

#if defined(_WIN32)
#define DllExport __declspec(dllexport)
#define LCC_API_PATH_SIZE 260
#else
#define DllExport
#define LCC_API_PATH_SIZE 1024
#endif

// Generated per-project at configure time by lccgen into
// projects/<LCC_PROJECT_NAME>/include/...; it is not checked into the repository.
// Consumers should get this definition from the licensecc CMake target.
#ifndef LCC_PROJECT_CONFIG_HEADER
#error "LCC_PROJECT_CONFIG_HEADER is not defined. Link against licensecc::licensecc_static or define the project-scoped generated properties header."
#endif
#include LCC_PROJECT_CONFIG_HEADER

typedef enum {
	LICENSE_OK = 0,  // OK
	LICENSE_FILE_NOT_FOUND = 1,  // license file not found
	LICENSE_SERVER_NOT_FOUND = 2,  // license server can't be contacted
	ENVIRONMENT_VARIABLE_NOT_DEFINED = 3,  // environment variable not defined
	FILE_FORMAT_NOT_RECOGNIZED = 4,  // license file has invalid format (not .ini file)
	LICENSE_MALFORMED = 5,  // some mandatory field are missing, or data can't be fully read.
	PRODUCT_NOT_LICENSED = 6,  // this product was not licensed
	PRODUCT_EXPIRED = 7,    //!< PRODUCT_EXPIRED
	LICENSE_CORRUPTED = 8,  // License signature didn't match with current license
	IDENTIFIERS_MISMATCH = 9,  // Calculated identifier and the one provided in license didn't match
	LICENSE_TAMPER_DETECTED = 10,  // Runtime tamper signal detected
	LICENSE_ONLINE_REQUIRED = 11,  // Online verification is required but not available
	LICENSE_ONLINE_VERIFICATION_FAILED = 12,  // Online entitlement verification failed
	LICENSE_ONLINE_ASSERTION_INVALID = 13,  // Online assertion was malformed, expired, or not authentic
	LICENSE_ONLINE_CACHE_EXPIRED = 14,  // Reserved for future persistent-cache APIs

	LICENSE_SPECIFIED = 100,  // license location was specified
	LICENSE_FOUND = 101,  // License file has been found or license data has been located
	PRODUCT_FOUND = 102,  // License has been loaded and the declared product has been found
	SIGNATURE_VERIFIED = 103//!< SIGNATURE_VERIFIED
} LCC_EVENT_TYPE;

typedef enum {
	LCC_LOCAL,
	LCC_REMOTE  // remote licenses are not supported now.
} LCC_LICENSE_TYPE;

typedef enum { SVRT_INFO, SVRT_WARN, SVRT_ERROR } LCC_SEVERITY;

typedef enum {
	LCC_TAMPER_DISABLED = 0,
	LCC_TAMPER_ENFORCE = 2
} LCC_TAMPER_POLICY;

#define LCC_TAMPER_FLAG_NONE 0u
#define LCC_TAMPER_FLAG_STRICT_SOURCE_SHADOWING 0x00000001u
#define LCC_ONLINE_FLAG_NONE 0u
#define LCC_CLIENT_HARDENING_NONE 0u
#define LCC_CLIENT_HARDENING_TAMPER_ENFORCE 0x00000001u
#define LCC_CLIENT_HARDENING_HOST_INTEGRITY 0x00000002u
#define LCC_CLIENT_HARDENING_SOURCE_SHADOWING 0x00000004u
#define LCC_CLIENT_HARDENING_ONLINE_REQUIRED 0x00000008u
#define LCC_API_ONLINE_PROJECT_SIZE 127u
#define LCC_API_ONLINE_NONCE_SIZE 64u
#define LCC_API_ONLINE_LICENSE_FINGERPRINT_SIZE 64u
#define LCC_API_ONLINE_DEVICE_HASH_SIZE 64u
#define LCC_API_ONLINE_ASSERTION_SIZE 4096u
#define LCC_ONLINE_REQUEST_VERSION 2u
#define LCC_ONLINE_DEFAULT_TIMEOUT_MS 3000u
#define LCC_ONLINE_MAX_TIMEOUT_MS 30000u
#define LCC_LICENSE_CHECK_OPTIONS_VERSION 2u
#define LCC_LICENSE_DECISION_OPTIONS_VERSION 1u
#define LCC_LICENSE_DECISION_VERSION 1u

typedef bool (*LCC_HOST_INTEGRITY_CHECK)(void* user_data, char* detail_out, size_t detail_out_size);

typedef enum {
	LCC_ONLINE_DISABLED = 0,
	LCC_ONLINE_REQUIRE = 2
} LCC_ONLINE_POLICY;

typedef enum {
	LCC_ONLINE_CB_OK = 0,
	LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE = 1,
	LCC_ONLINE_CB_TIMEOUT = 2,
	LCC_ONLINE_CB_BUFFER_TOO_SMALL = 3,
	LCC_ONLINE_CB_HOST_DECLINED = 4,
	LCC_ONLINE_CB_MALFORMED_RESPONSE = 5
} LCC_ONLINE_CALLBACK_STATUS;

typedef struct LccOnlineRequest {
	uint32_t size;
	uint32_t version;
	char project[LCC_API_ONLINE_PROJECT_SIZE + 1];
	char feature[LCC_API_FEATURE_NAME_SIZE + 1];
	char license_fingerprint[LCC_API_ONLINE_LICENSE_FINGERPRINT_SIZE + 1];
	char device_hash[LCC_API_ONLINE_DEVICE_HASH_SIZE + 1];
	char nonce[LCC_API_ONLINE_NONCE_SIZE + 1];
	LCC_ONLINE_POLICY policy;
	uint32_t flags;
	uint32_t timeout_ms;
	uint32_t client_hardening;  // bitset of LCC_CLIENT_HARDENING_*; client configuration posture, telemetry only
} LccOnlineRequest;

typedef LCC_ONLINE_CALLBACK_STATUS (*LCC_ONLINE_CHECK)(void* user_data, const LccOnlineRequest* request,
													   char* assertion_out, size_t* assertion_out_size);

typedef struct LicenseCheckOptions {
	uint32_t size;
	uint32_t version;
	LCC_TAMPER_POLICY tamper_policy;
	uint32_t tamper_flags;
	LCC_HOST_INTEGRITY_CHECK host_integrity_check;
	void* host_integrity_user_data;
	LCC_ONLINE_POLICY online_policy;
	uint32_t online_flags;
	uint32_t online_timeout_ms;
	LCC_ONLINE_CHECK online_check;
	void* online_user_data;
	char online_device_hash[LCC_API_ONLINE_DEVICE_HASH_SIZE + 1];
} LicenseCheckOptions;

typedef enum {
	LCC_LICENSE_DECISION_DENY = 0,
	LCC_LICENSE_DECISION_ALLOW = 1
} LCC_LICENSE_DECISION;

typedef struct LccRevocationFloorRecord {
	uint32_t size;
	uint32_t version;
	char project[LCC_API_ONLINE_PROJECT_SIZE + 1];
	char feature[LCC_API_FEATURE_NAME_SIZE + 1];
	char license_fingerprint[LCC_API_ONLINE_LICENSE_FINGERPRINT_SIZE + 1];
	uint64_t revocation_seq;
} LccRevocationFloorRecord;

typedef bool (*LCC_REVOCATION_FLOOR_LOAD)(void* user_data, const LccRevocationFloorRecord* key,
										  uint64_t* revocation_seq_out);
typedef bool (*LCC_REVOCATION_FLOOR_STORE)(void* user_data, const LccRevocationFloorRecord* record);

typedef struct LccLicenseDecisionOptions {
	uint32_t size;
	uint32_t version;
	LCC_ONLINE_CHECK online_check;
	void* online_user_data;
	LCC_HOST_INTEGRITY_CHECK host_integrity_check;
	void* host_integrity_user_data;
	LCC_REVOCATION_FLOOR_LOAD revocation_floor_load;
	LCC_REVOCATION_FLOOR_STORE revocation_floor_store;
	void* revocation_floor_user_data;
	uint32_t online_timeout_ms;
	uint32_t reserved;
	char online_device_hash[LCC_API_ONLINE_DEVICE_HASH_SIZE + 1];
} LccLicenseDecisionOptions;

typedef struct LccLicenseDecision {
	uint32_t size;
	uint32_t version;
	LCC_LICENSE_DECISION decision;
	LCC_EVENT_TYPE event_type;
	bool online_verified;
	bool revocation_floor_loaded;
	bool revocation_floor_stored;
	bool tamper_enforced;
	uint32_t reserved;
	LccRevocationFloorRecord revocation_floor;
} LccLicenseDecision;

typedef struct {
	LCC_SEVERITY severity;
	LCC_EVENT_TYPE event_type;
	/**
	 * License file name or location where the license is stored.
	 */
	char license_reference[LCC_API_PATH_SIZE];
	char param2[LCC_API_AUDIT_EVENT_PARAM2 + 1];
} AuditEvent;

typedef enum {
	/**
	 * A list of absolute path separated by ';' containing the eventual location
	 * of the license files. Can be NULL.
	 */
	LICENSE_PATH,
	/**
	 * The license is provided as plain data
	 */
	LICENSE_PLAIN_DATA,
	/**
	 * The license is encoded
	 */
	LICENSE_ENCODED
} LCC_LICENSE_DATA_TYPE;

/**
 * This structure contains informations on the raw license data. Software authors
 * can specify the location of the license file or its full content.
 *
 * Can be NULL, in this case OpenLicenseManager will try to figure out the
 * license file location on its own.
 */
typedef struct {
	LCC_LICENSE_DATA_TYPE license_data_type;
	char licenseData[LCC_API_MAX_LICENSE_DATA_LENGTH];
} LicenseLocation;

/**
 * Informations about the software requesting the license verification (eg, software version, feature to verify).
 */
typedef struct {
	/**
	 * Software version in format xxxx[.xxxx.xxxx].
	 * Required when a license uses start-version or end-version limits.
	 * If such a license is checked without a caller version, or with a malformed
	 * caller version, verification fails closed with PRODUCT_NOT_LICENSED.
	 */
	char version[LCC_API_VERSION_LENGTH + 1];
	/**
	 * Name of the feature you want to verify. If empty ('\0') the 'default' feature will be verified.
	 * (every project has a default feature that is equal to the project name).
	 * Every feature has a separate section in the license file:
	 * <pre>
	 * [feature_xx]
	 * sig=AAAA
	 * [another_feature]
	 * expiry-date=20201111
	 * </pre>
	 */
	char feature_name[LCC_API_FEATURE_NAME_SIZE + 1];
	/**
	 * this number passed in by the application must correspond to the magic number used when compiling the library.
	 * See cmake parameter -DLCC_PROJECT_MAGIC_NUM and generated licensecc_properties.h macros
	 * LCC_PROJECT_MAGIC_NUM and LCC_VERIFY_MAGIC.
	 */
	unsigned int magic;
} CallerInformations;

typedef struct {
	/**
	 * Detailed reason of success/failure. Reasons for a failure can be
	 * multiple (for instance, license expired and signature not verified).
	 * Only the last AUDIT_EVENT_NUM are reported.
	 */
	AuditEvent status[LCC_API_AUDIT_EVENT_NUM];
	/**
	 * Eventual expiration date of the software,
	 * can be '\0' if the software don't expire
	 * */
	char expiry_date[LCC_API_EXPIRY_DATE_SIZE + 1];
	unsigned int days_left;
	bool has_expiry;
	bool linked_to_pc;
	LCC_LICENSE_TYPE license_type;  // Local or Remote
	/* A string of character inserted into the license understood
	 * by the calling application.
	 * '\0' if the application didn't specify one */
	char proprietary_data[LCC_API_PROPRIETARY_DATA_SIZE + 1];
	int license_version;  // license file version
} LicenseInfo;

typedef enum { BARE_TO_METAL, VMWARE, VIRTUALBOX, V_XEN, KVM, HV, PARALLELS, V_OTHER } LCC_API_VIRTUALIZATION_DETAIL;

typedef enum {
	PROV_UNKNOWN = 0,
	ON_PREMISE = 1,
	GOOGLE_CLOUD = 2,
	AZURE_CLOUD = 3,
	AWS = 4,
	/**
	 * "/sys/class/dmi/id/bios_vendor" SeaBIOS
	 * "/sys/class/dmi/id/sys_vendor" Alibaba Cloud
	 * modalias
	 * "dmi:bvnSeaBIOS:bvrrel-1.7.5-0-ge51488c-20140602_164612-nilsson.home.kraxel.org:bd04/01/2014:svnAlibabaCloud:pnAlibabaCloudECS:pvrpc-i440fx-2.1:cvnAlibabaCloud:ct1:cvrpc-i440fx-2.1:"
	 */
	ALI_CLOUD = 5
} LCC_API_CLOUD_PROVIDER;

typedef enum { NONE, CONTAINER, VM } LCC_API_VIRTUALIZATION_SUMMARY;

typedef struct {
	LCC_API_CLOUD_PROVIDER cloud_provider;
	LCC_API_VIRTUALIZATION_SUMMARY virtualization;
	LCC_API_VIRTUALIZATION_DETAIL virtualization_detail;
} ExecutionEnvironmentInfo;

#ifdef __cplusplus
}
#endif

/**
 * @}
 */
#endif
