/** \addtogroup api
 * @{
 */
#ifndef LICENSEPP_H_
#define LICENSEPP_H_

/*
 * Public Licensecc API.
 *
 * The functions use C linkage, but the distributed package is currently
 * validated for C++ consumers linking the C++ static runtime target. Pure C
 * hosts should use a C++ linker rule or a project-owned wrapper with its own
 * installed-prefix smoke test.
 */
#ifdef __cplusplus
extern "C" {
#endif

#include "datatypes.h"

/**
 * Returns a static, human-readable description for an ::LCC_EVENT_TYPE code
 * (e.g. the value returned by ::acquire_license). The returned string is owned
 * by the library and must not be freed.
 */
const char* lcc_strerror(LCC_EVENT_TYPE event_type);

/**
 * Initializes public API structs to a safe default state. These helpers are
 * null-safe. lcc_init_caller_informations() also sets magic to the generated
 * LCC_PROJECT_MAGIC_NUM for the linked project.
 */
void lcc_init_caller_informations(CallerInformations* callerInformation);
void lcc_init_license_location(LicenseLocation* licenseLocation, LCC_LICENSE_DATA_TYPE license_data_type);
void lcc_init_license_info(LicenseInfo* licenseInfo);
/**
 * Initializes ::LicenseCheckOptions for ::acquire_license_ex. Defaults to
 * audit mode so tamper signals are reported as warnings while a valid license
 * remains accepted, and online verification disabled for compatibility. Set
 * tamper_policy to ::LCC_TAMPER_ENFORCE only after host-specific false-positive
 * testing. Set online_policy to ::LCC_ONLINE_AUDIT or ::LCC_ONLINE_REQUIRE and
 * provide online_check when the host application owns the network transport.
 */
void lcc_init_license_check_options(LicenseCheckOptions* options);

/**
 * Bounded setters for fixed-size public ABI buffers. They return false and
 * clear the destination field if the input is null or too large for the
 * destination including its terminating NUL.
 */
bool lcc_set_caller_feature_name(CallerInformations* callerInformation, const char* feature_name);
bool lcc_set_caller_version(CallerInformations* callerInformation, const char* version);
bool lcc_set_license_location_data(LicenseLocation* licenseLocation, LCC_LICENSE_DATA_TYPE license_data_type,
								   const char* license_data);
bool lcc_set_license_path(LicenseLocation* licenseLocation, const char* license_path);

/**
 * Writes a human-readable summary of the (warning/error) audit events contained
 * in `licenseInfo` into `out_buffer` (always NUL-terminated, truncated to
 * LCC_API_ERROR_BUFFER_SIZE). Useful to show the end user why a license check
 * failed.
 *
 * Precondition: `licenseInfo` must be a struct populated by ::acquire_license
 * (or, if built by other means, zero-initialized) - `status` is read in full,
 * so an uninitialized struct yields undefined output.
 */
void print_error(char out_buffer[LCC_API_ERROR_BUFFER_SIZE], const LicenseInfo* licenseInfo);

/**
 * \brief Calculates the hardware identifier associated with a specific pc.
 * \details
 * The caller, when it doesn't find a valid license (see `acquire_license`
 * below) may show the calculated identifier to the user so the user can send
 * it to the software editor for license issuance.
 *
 * Hardware identifiers may contain device, network, disk, host, tenant, or
 * personal data. Do not print raw identifiers in normal application logs,
 * support bundles, public issue trackers, or telemetry. Redact them by default
 * and request raw values only through an explicit trusted support workflow.
 *
 * pc_id_method = ::STRATEGY_DEFAULT is usually the best choice.
 *
 * First call this method with `identifier_out` = nullptr and `*buf_size` = 0; it will return the requested buffer size
 * in the `buf_size` parameter. If `buf_size` is nullptr the function returns false.
 *
 * Then allocate the necessary memory, and call the method again.
 *
 * @return true if successful, false if failure (because it is not possible to identify or buffer too small).
 * @param hw_id_method[in] specifies a preferred identification method. Usually #STRATEGY_DEFAULT works well. See the
 * wiki for more informations.
 * @param identifier_out[out] buffer where the identification string will be placed.
 * @param buf_size[in-out] size of the buffer where the identification string will be placed.
 * @param execution_environment_info[out] if not null will contain the informations about the execution environment.
 */
bool identify_pc(LCC_API_HW_IDENTIFICATION_STRATEGY hw_id_method, char* identifier_out, size_t* buf_size,
				 ExecutionEnvironmentInfo* execution_environment_info);

/**
 * This method is used to request the use of one license for a product.
 * In case of local license it's used to check if the product is licensed.
 *
 * @return LCC_EVENT_TYPE::LICENSE_OK(0) if successful. Other values mean the
 * 			requested product or feature must be treated as not licensed.
 *
 * @param callerInformation[in] optional, can be NULL.
 * 			contains informations on the software that is requesting the license verification. Let the software
 * 			specify its version or request verification for features that need to be enabled separately.
 * 			When a license has start-version or end-version limits, a missing or malformed caller version
 * 			fails closed with PRODUCT_NOT_LICENSED.
 * @param licenseLocation[in] optional, can be NULL.
 * 					licenseLocation, either the name of the file
 * 								or the name of the environment variable should be !='\0'
 * @param license_out[out] optional, can be NULL. If set, it is reset before validation and populated with license
 * 							information and audit status for the result.
 */

LCC_EVENT_TYPE acquire_license(const CallerInformations* callerInformation, const LicenseLocation* licenseLocation,
						   LicenseInfo* license_out);

/**
 * Extended license check with per-call runtime tamper evaluation. The normal
 * license verifier runs first. Tamper checks are evaluated only after the
 * license would otherwise return ::LICENSE_OK, so ordinary license failures are
 * not masked by runtime diagnostics. Online verification, when enabled through
 * ::LicenseCheckOptions, also runs only after a local license succeeds and
 * after tamper enforcement has not denied the license.
 *
 * Licensecc core does not perform HTTP. The host callback receives a
 * ::LccOnlineRequest containing project, feature, license fingerprint, device
 * hash, and a core-generated nonce. It writes a signed assertion envelope into
 * the provided output buffer. Audit online policy reports failures as warnings;
 * require policy returns an online failure event.
 *
 * A null options pointer uses the same defaults as
 * ::lcc_init_license_check_options. Invalid size/version fields fail closed
 * with ::LICENSE_MALFORMED.
 */
LCC_EVENT_TYPE acquire_license_ex(const CallerInformations* callerInformation, const LicenseLocation* licenseLocation,
								  LicenseInfo* license_out, const LicenseCheckOptions* options);

/**
 * Enables or disables license lookup through process environment variables
 * (`LICENSE_LOCATION` and `LICENSE_DATA`). Hardened generated projects disable
 * environment lookup by default. Enable it only for trusted test, support, or
 * compatibility flows; production hosts should normally pass an explicit
 * ::LicenseLocation to ::acquire_license or use the colocated license-file
 * lookup. This process-global policy is atomic but should be configured once
 * during single-threaded startup before worker threads begin license checks.
 */
void lcc_set_environment_license_sources_enabled(bool enabled);

/**
 * Enables or disables strict source-fatal handling. The default is disabled for
 * compatibility: if one license candidate verifies, malformed candidates are
 * reported as warning audit events. When enabled, malformed or invalid-format
 * candidates remain fatal even when another candidate verifies successfully.
 * Hosts that treat explicit or environment-provided license sources as
 * authoritative should enable this mode before calling ::acquire_license. This
 * process-global policy is atomic but should be configured once during
 * single-threaded startup before worker threads begin license checks.
 */
void lcc_set_strict_source_fatal_enabled(bool enabled);

/**
 * Not implemented yet, useful (later) for network licenses.
 * Should be called from time to time to confirm we're still using the
 * license. Until this API is implemented, it fails closed and must not be used
 * as an entitlement decision. Use ::acquire_license for authorization.
 */
LCC_EVENT_TYPE confirm_license(char* featureName, LicenseLocation* licenseLocation);
/**
 * Not implemented yet, useful (later) for network licenses.
 * Until this API is implemented, it fails closed and must not be used as an
 * entitlement decision. Use ::acquire_license for authorization.
 */
LCC_EVENT_TYPE release_license(char* featureName, LicenseLocation licenseLocation);

#ifdef __cplusplus
}
#endif

#endif
/**
 * @}
 */
