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
 * Compile-time library version. Kept in sync with the `project(... VERSION ...)`
 * declaration in the top-level CMakeLists.txt (and doc/conf.py). Consumers can
 * use these for conditional compilation and minimum-version assertions, e.g.
 * `#if LCC_VERSION_NUMBER < 20100`.
 */
#define LCC_VERSION_MAJOR 2
#define LCC_VERSION_MINOR 1
#define LCC_VERSION_PATCH 0
#define LCC_VERSION_STRING "2.1.0"
#define LCC_VERSION_NUMBER ((LCC_VERSION_MAJOR * 10000) + (LCC_VERSION_MINOR * 100) + LCC_VERSION_PATCH)

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
 * the secure runtime policy: tamper signals are enforced, strict source
 * shadowing is enabled, and online verification is disabled unless the host
 * supplies online_check. When online_check is set, online verification is
 * required and must return a fresh signed assertion.
 */
void lcc_init_license_check_options(LicenseCheckOptions* options);
/**
 * Initializes the revocation-floor record used by the online decision APIs.
 * Hosts that persist rollback floors fill project, feature, license_fingerprint,
 * and revocation_seq before calling ::lcc_set_online_revocation_floor.
 */
void lcc_init_revocation_floor_record(LccRevocationFloorRecord* record);
/**
 * Initializes ::LccLicenseDecisionOptions for ::lcc_acquire_license_decision.
 * This higher-level entry point owns the secure policy choices: tamper
 * enforcement and strict source shadowing are always enabled, online
 * verification is required, and persisted revocation-floor load/store
 * callbacks are required.
 */
void lcc_init_license_decision_options(LccLicenseDecisionOptions* options);
/**
 * Initializes ::LccLicenseDecision output. The default decision is deny.
 */
void lcc_init_license_decision(LccLicenseDecision* decision);

/** Initializes ::LccConfigInput (null-safe). */
void lcc_init_config_input(LccConfigInput* input);
/** Initializes ::LccConfigVerifyOptions (null-safe). */
void lcc_init_config_verify_options(LccConfigVerifyOptions* options);
/** Initializes ::LccConfigDecision; the default decision is deny. */
void lcc_init_config_decision(LccConfigDecision* decision);
/** Initializes ::LccConfigSeqFloorRecord (null-safe). */
void lcc_init_config_seq_floor_record(LccConfigSeqFloorRecord* record);
/** Bounded setter for the optional device hash: copies it if it fits the field
 * (otherwise clears it and returns false). The 64-hex-char-or-empty format is
 * validated later by ::lcc_verify_config, not here. */
bool lcc_set_config_device_hash(LccConfigInput* input, const char* device_hash);

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
 * pc_id_method = STRATEGY_DEFAULT is usually the best choice.
 *
 * First call this method with `identifier_out` = nullptr and `*buf_size` = 0; it will return the requested buffer size
 * in the `buf_size` parameter. If `buf_size` is nullptr the function returns false.
 *
 * Then allocate the necessary memory, and call the method again.
 *
 * @return true if successful, false if failure (because it is not possible to identify or buffer too small).
 * @param[in] hw_id_method specifies a preferred identification method. Usually STRATEGY_DEFAULT works well. See the
 * wiki for more informations.
 * @param[out] identifier_out buffer where the identification string will be placed.
 * @param[in,out] buf_size size of the buffer where the identification string will be placed.
 * @param[out] execution_environment_info if not null will contain the informations about the execution environment.
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
 * @param[in] callerInformation optional, can be NULL.
 * 			contains informations on the software that is requesting the license verification. Let the software
 * 			specify its version or request verification for features that need to be enabled separately.
 * 			When a license has start-version or end-version limits, a missing or malformed caller version
 * 			fails closed with PRODUCT_NOT_LICENSED.
 * @param[in] licenseLocation optional, can be NULL.
 * 					licenseLocation, either the name of the file
 * 								or the name of the environment variable should be !='\0'
 * @param[out] license_out optional, can be NULL. If set, it is reset before validation and populated with license
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
 * the provided output buffer. Online failures return an online failure event.
 *
 * A null options pointer uses the same defaults as
 * ::lcc_init_license_check_options. Invalid size/version fields fail closed
 * with ::LICENSE_MALFORMED.
 *
 * Raw-path caveat: when you call ::acquire_license_ex directly with online
 * verification enabled, it enforces only the PROCESS-LOCAL revocation floor (see
 * ::lcc_set_online_revocation_floor / ::lcc_get_online_revocation_floor). It does
 * not accept or invoke any persisted floor callbacks (::LicenseCheckOptions has
 * none), so a process that restarts without restoring the floor can accept a
 * superseded assertion. Restore the persisted floor at startup with
 * ::lcc_set_online_revocation_floor. For persisted load/store wiring on every
 * decision, use ::lcc_acquire_license_decision, which is preferred for production
 * hosts.
 */
LCC_EVENT_TYPE acquire_license_ex(const CallerInformations* callerInformation, const LicenseLocation* licenseLocation,
								  LicenseInfo* license_out, const LicenseCheckOptions* options);

/**
 * Production decision wrapper. It orchestrates the local license check,
 * configures anti-tamper enforcement, requires online verification, and enforces
 * a persisted revocation-sequence rollback floor, collapsing the result to a
 * single ::LICENSE_OK only when the decision is ::LCC_LICENSE_DECISION_ALLOW.
 *
 * What this DOES guarantee: required online verification ran and a signed
 * assertion was accepted; the persisted revocation floor was loaded and the
 * accepted revocation_seq stored; load/store failures fail closed so a restarted
 * process cannot accept an older assertion.
 *
 * What this does NOT guarantee: it cannot prove code ran on an attacker-controlled
 * host. `decision_out->tamper_enforced` means the wrapper *configured* tamper
 * enforcement for the call -- it does not prove every optional host-integrity
 * probe executed, and a local license failure can deny before any runtime
 * callback is evaluated. Treat the server (the online verifier) as authoritative;
 * this wrapper is defense-in-depth, not a guarantee about the client process.
 *
 * The host callbacks in ::LccLicenseDecisionOptions must load and store the
 * strongest revocation_seq seen for the exact project/feature/license
 * fingerprint.
 */
LCC_EVENT_TYPE lcc_acquire_license_decision(const CallerInformations* callerInformation,
											const LicenseLocation* licenseLocation, LicenseInfo* license_out,
											LccLicenseDecision* decision_out,
											const LccLicenseDecisionOptions* options);

/**
 * Verifies a server-signed configuration token against the bytes the
 * application will use, binding it to a valid local license. This is the
 * combined entry point: it performs the one license read (use it instead of
 * ::acquire_license when you have a config to check) and binds the config to
 * that license's fingerprint, project, and feature.
 *
 * Returns ::LICENSE_OK only when the local license is valid AND the config
 * token verifies (signature, binding, config-hash, window, rollback floor).
 * Otherwise returns the license failure or a LICENSE_CONFIG_* code, and sets
 * `decision_out->decision` to deny. `license_out` receives the license audit
 * status; `decision_out` receives the config decision. Invalid size/version
 * inputs fail closed with ::LICENSE_MALFORMED.
 */
LCC_EVENT_TYPE lcc_verify_config(const CallerInformations* callerInformation,
								 const LicenseLocation* licenseLocation, LicenseInfo* license_out,
								 const LccConfigInput* input, LccConfigDecision* decision_out,
								 const LccConfigVerifyOptions* options);

/**
 * Process-local online revocation-floor helpers, useful for tests and for hosts
 * that restore a persisted floor at startup before calling ::acquire_license_ex
 * directly (which, used raw, requires the caller to own floor load/store -- see
 * its caveat). The secure decision wrapper above is preferred because it
 * loads/stores the floor on every successful online decision.
 */
bool lcc_set_online_revocation_floor(const LccRevocationFloorRecord* record);
bool lcc_get_online_revocation_floor(LccRevocationFloorRecord* record);

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
 * compatibility: if one license candidate verifies, rejected candidates are
 * reported as warning audit events. When enabled, suspicious rejected
 * candidates such as malformed, corrupted, expired, identifier-mismatched, or
 * unlicensed-product sources remain fatal even when another candidate verifies
 * successfully. Hosts that treat explicit or environment-provided license
 * sources as authoritative should enable this mode before calling
 * ::acquire_license. This process-global policy is atomic but should be
 * configured once during single-threaded startup before worker threads begin
 * license checks.
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
