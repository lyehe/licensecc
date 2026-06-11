//============================================================================
// Name        : licensecc.cpp
// Author      :
// Version     :
// Copyright   : BSD
//============================================================================

#define __STDC_WANT_LIB_EXT1__ 1
#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstddef>
#include <fstream>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <cstring>
#include <exception>
#include <iostream>
#include <vector>

#include <licensecc/datatypes.h>
#include <licensecc/licensecc.h>
#include <licensecc_properties.h>

#include "anti_tamper/AntiTamper.hpp"
#include "online_verification/OnlineVerification.hpp"
#include "base/base64.h"
#include "base/logger.h"
#include "base/string_utils.h"
#include "hw_identifier/hw_identifier_facade.hpp"
#include "os/execution_environment.hpp"
#include "os/signature_verifier.hpp"
#include "limits/license_verifier.hpp"
#include "base/string_utils.h"
#include "LicenseReader.hpp"
#include "locate/LocatorFactory.hpp"

using namespace std;

static std::atomic_bool strict_source_fatal_enabled{false};

struct AcquiredLicenseContext {
	string project;
	string feature;
	string license_fingerprint;
};

struct VerifiedLicenseCandidate {
	LicenseInfo info;
	AcquiredLicenseContext context;
};

struct RevocationFloorCallbacks {
	LCC_REVOCATION_FLOOR_LOAD load = nullptr;
	LCC_REVOCATION_FLOOR_STORE store = nullptr;
	void* user_data = nullptr;
};

struct RuntimeHardeningStatus {
	bool online_verified = false;
	bool revocation_floor_loaded = false;
	bool revocation_floor_stored = false;
	bool tamper_enforced = false;
	LccRevocationFloorRecord revocation_floor{};
};

const char* lcc_strerror(LCC_EVENT_TYPE event_type) {
	switch (event_type) {
		case LICENSE_OK:
			return "license OK";
		case LICENSE_FILE_NOT_FOUND:
			return "license file not found";
		case LICENSE_SERVER_NOT_FOUND:
			return "license server can't be contacted";
		case ENVIRONMENT_VARIABLE_NOT_DEFINED:
			return "license environment variable not defined";
		case FILE_FORMAT_NOT_RECOGNIZED:
			return "license file has an invalid format (not an .ini file)";
		case LICENSE_MALFORMED:
			return "mandatory fields are missing or the license can't be fully read";
		case PRODUCT_NOT_LICENSED:
			return "this product was not licensed";
		case PRODUCT_EXPIRED:
			return "license expired";
		case LICENSE_CORRUPTED:
			return "license signature didn't match";
		case IDENTIFIERS_MISMATCH:
			return "the calculated hardware identifier and the one in the license didn't match";
		case LICENSE_TAMPER_DETECTED:
			return "runtime tamper signal detected";
		case LICENSE_ONLINE_REQUIRED:
			return "online license verification required";
		case LICENSE_ONLINE_VERIFICATION_FAILED:
			return "online license verification failed";
		case LICENSE_ONLINE_ASSERTION_INVALID:
			return "online license assertion invalid";
		case LICENSE_ONLINE_CACHE_EXPIRED:
			return "online license verification cache expired (reserved)";
		case LICENSE_SPECIFIED:
			return "license location specified";
		case LICENSE_FOUND:
			return "license found";
		case PRODUCT_FOUND:
			return "product found in license";
		case SIGNATURE_VERIFIED:
			return "license signature verified";
		default:
			return "unknown license event";
	}
}

static bool lcc_copy_public_string(char* out, const size_t out_size, const char* value) {
	if (out == nullptr || out_size == 0) {
		return false;
	}
	out[0] = '\0';
	if (value == nullptr) {
		return false;
	}
	const size_t value_size = license::mstrnlen_s(value, out_size);
	if (value_size >= out_size) {
		return false;
	}
	memcpy(out, value, value_size + 1);
	return true;
}

static bool is_public_hex_string(const char* value, const size_t size) {
	for (size_t i = 0; i < size; ++i) {
		if (!std::isxdigit(static_cast<unsigned char>(value[i]))) {
			return false;
		}
	}
	return true;
}

static bool fixed_public_field_to_string(const char* value, const size_t capacity, const bool allow_empty,
										 string& out, string& error, const char* field_name) {
	const size_t size = license::mstrnlen_s(value, capacity);
	if (size == capacity) {
		error = string(field_name) + " is not NUL-terminated";
		return false;
	}
	if (!allow_empty && size == 0) {
		error = string(field_name) + " is empty";
		return false;
	}
	out.assign(value, size);
	return true;
}

static bool floor_record_key_to_strings(const LccRevocationFloorRecord* record, string& project, string& feature,
										string& license_fingerprint, string& error) {
	if (record == nullptr) {
		error = "revocation floor record is null";
		return false;
	}
	if (record->size != sizeof(LccRevocationFloorRecord)) {
		error = "invalid revocation floor record size";
		return false;
	}
	if (record->version != LCC_LICENSE_DECISION_VERSION) {
		error = "invalid revocation floor record version";
		return false;
	}
	if (!fixed_public_field_to_string(record->project, sizeof(record->project), false, project, error, "project") ||
		!fixed_public_field_to_string(record->feature, sizeof(record->feature), false, feature, error, "feature") ||
		!fixed_public_field_to_string(record->license_fingerprint, sizeof(record->license_fingerprint), false,
									  license_fingerprint, error, "license_fingerprint")) {
		return false;
	}
	if (license_fingerprint.size() != LCC_API_ONLINE_LICENSE_FINGERPRINT_SIZE ||
		!is_public_hex_string(license_fingerprint.c_str(), license_fingerprint.size())) {
		error = "license_fingerprint is not 64 hex characters";
		return false;
	}
	return true;
}

static bool floor_record_from_context(const AcquiredLicenseContext& context, const uint64_t revocation_seq,
									  LccRevocationFloorRecord& record, string& error) {
	record = LccRevocationFloorRecord{};
	record.size = sizeof(LccRevocationFloorRecord);
	record.version = LCC_LICENSE_DECISION_VERSION;
	record.revocation_seq = revocation_seq;
	if (!lcc_copy_public_string(record.project, sizeof(record.project), context.project.c_str())) {
		error = "project exceeds revocation floor record buffer";
		return false;
	}
	if (!lcc_copy_public_string(record.feature, sizeof(record.feature), context.feature.c_str())) {
		error = "feature exceeds revocation floor record buffer";
		return false;
	}
	if (!lcc_copy_public_string(record.license_fingerprint, sizeof(record.license_fingerprint),
								context.license_fingerprint.c_str())) {
		error = "license fingerprint exceeds revocation floor record buffer";
		return false;
	}
	return true;
}

void lcc_init_caller_informations(CallerInformations* callerInformation) {
	if (callerInformation == nullptr) {
		return;
	}
	*callerInformation = CallerInformations{};
	callerInformation->magic = LCC_PROJECT_MAGIC_NUM;
}

void lcc_init_license_location(LicenseLocation* licenseLocation, LCC_LICENSE_DATA_TYPE license_data_type) {
	if (licenseLocation == nullptr) {
		return;
	}
	*licenseLocation = LicenseLocation{};
	licenseLocation->license_data_type = license_data_type;
}

void lcc_init_license_info(LicenseInfo* licenseInfo) {
	if (licenseInfo == nullptr) {
		return;
	}
	*licenseInfo = LicenseInfo{};
}

void lcc_init_license_check_options(LicenseCheckOptions* options) {
	if (options == nullptr) {
		return;
	}
	*options = LicenseCheckOptions{};
	options->size = sizeof(LicenseCheckOptions);
	options->version = LCC_LICENSE_CHECK_OPTIONS_VERSION;
	options->tamper_policy = LCC_TAMPER_ENFORCE;
	options->tamper_flags = LCC_TAMPER_FLAG_STRICT_SOURCE_SHADOWING;
	options->online_policy = LCC_ONLINE_DISABLED;
	options->online_flags = LCC_ONLINE_FLAG_NONE;
	options->online_timeout_ms = LCC_ONLINE_DEFAULT_TIMEOUT_MS;
}

void lcc_init_revocation_floor_record(LccRevocationFloorRecord* record) {
	if (record == nullptr) {
		return;
	}
	*record = LccRevocationFloorRecord{};
	record->size = sizeof(LccRevocationFloorRecord);
	record->version = LCC_LICENSE_DECISION_VERSION;
}

void lcc_init_license_decision_options(LccLicenseDecisionOptions* options) {
	if (options == nullptr) {
		return;
	}
	*options = LccLicenseDecisionOptions{};
	options->size = sizeof(LccLicenseDecisionOptions);
	options->version = LCC_LICENSE_DECISION_OPTIONS_VERSION;
	options->online_timeout_ms = LCC_ONLINE_DEFAULT_TIMEOUT_MS;
}

void lcc_init_license_decision(LccLicenseDecision* decision) {
	if (decision == nullptr) {
		return;
	}
	*decision = LccLicenseDecision{};
	decision->size = sizeof(LccLicenseDecision);
	decision->version = LCC_LICENSE_DECISION_VERSION;
	decision->decision = LCC_LICENSE_DECISION_DENY;
	decision->event_type = PRODUCT_NOT_LICENSED;
	lcc_init_revocation_floor_record(&decision->revocation_floor);
}

bool lcc_set_caller_feature_name(CallerInformations* callerInformation, const char* feature_name) {
	if (callerInformation == nullptr) {
		return false;
	}
	return lcc_copy_public_string(callerInformation->feature_name, sizeof(callerInformation->feature_name),
								  feature_name);
}

bool lcc_set_caller_version(CallerInformations* callerInformation, const char* version) {
	if (callerInformation == nullptr) {
		return false;
	}
	return lcc_copy_public_string(callerInformation->version, sizeof(callerInformation->version), version);
}

bool lcc_set_license_location_data(LicenseLocation* licenseLocation, LCC_LICENSE_DATA_TYPE license_data_type,
								   const char* license_data) {
	if (licenseLocation == nullptr) {
		return false;
	}
	licenseLocation->license_data_type = license_data_type;
	return lcc_copy_public_string(licenseLocation->licenseData, sizeof(licenseLocation->licenseData), license_data);
}

bool lcc_set_license_path(LicenseLocation* licenseLocation, const char* license_path) {
	return lcc_set_license_location_data(licenseLocation, LICENSE_PATH, license_path);
}

void print_error(char out_buffer[LCC_API_ERROR_BUFFER_SIZE], const LicenseInfo* licenseInfo) {
	if (out_buffer == nullptr) {
		return;
	}
	string msg;
	if (licenseInfo == nullptr) {
		msg = "no license information available";
	} else {
		for (int i = 0; i < LCC_API_AUDIT_EVENT_NUM; i++) {
			const AuditEvent& ev = licenseInfo->status[i];
			// info events are successes (or zeroed/unused slots); only surface problems
			if (ev.severity == SVRT_INFO) {
				continue;
			}
			if (!msg.empty()) {
				msg += "; ";
			}
			msg += (ev.severity == SVRT_ERROR) ? "ERROR: " : "WARN: ";
			msg += lcc_strerror(ev.event_type);
			if (ev.param2[0] != '\0') {
				msg += ": ";
				msg += ev.param2;
			}
			if (ev.license_reference[0] != '\0') {
				msg += " [";
				msg += ev.license_reference;
				msg += "]";
			}
		}
		if (msg.empty()) {
			msg = lcc_strerror(LICENSE_OK);
		}
	}
	license::mstrlcpy(out_buffer, msg.c_str(), LCC_API_ERROR_BUFFER_SIZE);
}

bool identify_pc(LCC_API_HW_IDENTIFICATION_STRATEGY pc_id_method, char* chbuffer, size_t* bufSize,
				 ExecutionEnvironmentInfo* execution_environment_info) {
	bool result = false;
	if (bufSize != nullptr) {
		if (*bufSize > LCC_API_PC_IDENTIFIER_SIZE && chbuffer != nullptr) {
			try {
				const string pc_id = license::hw_identifier::HwIdentifierFacade::generate_user_pc_signature(pc_id_method);
				license::mstrlcpy(chbuffer, pc_id.c_str(), *bufSize);
				result = true;
			} catch (const std::exception& ex) {
				LOG_ERROR("Error calculating hw_identifier: %s", ex.what());
			}
		} else {
			*bufSize = LCC_API_PC_IDENTIFIER_SIZE + 1;
		}
	}
	static const license::os::ExecutionEnvironment exec_env;
	if (execution_environment_info != nullptr) {
		execution_environment_info->cloud_provider = exec_env.cloud_provider();
		execution_environment_info->virtualization = exec_env.virtualization();
		execution_environment_info->virtualization_detail = exec_env.virtualization_detail();
	}
	return result;
}

static void mergeLicenses(const vector<LicenseInfo>& licenses, LicenseInfo* license_out) {
	if (license_out != nullptr) {
		int days_left = INT_MIN;
		for (auto it = licenses.begin(); it != licenses.end(); it++) {
			// choose the license that expires later...
			if (!it->has_expiry) {
				*license_out = *it;
				break;
			} else if (days_left < (int)it->days_left) {
				*license_out = *it;
				days_left = it->days_left;
			}
		}
	}
}

static void mergeVerifiedLicenses(const vector<VerifiedLicenseCandidate>& licenses, LicenseInfo* license_out,
								  AcquiredLicenseContext* context_out) {
	if (licenses.empty()) {
		return;
	}
	size_t selected = 0;
	int days_left = INT_MIN;
	for (size_t i = 0; i < licenses.size(); ++i) {
		const LicenseInfo& info = licenses[i].info;
		if (!info.has_expiry) {
			selected = i;
			break;
		}
		if (days_left < static_cast<int>(info.days_left)) {
			selected = i;
			days_left = info.days_left;
		}
	}
	if (license_out != nullptr) {
		*license_out = licenses[selected].info;
	}
	if (context_out != nullptr) {
		*context_out = licenses[selected].context;
	}
}

static string fingerprint_for_license(const license::FullLicenseInfo& license_info) {
	vector<uint8_t> signature = license::unbase64(license_info.license_signature);
	if (signature.empty()) {
		signature.assign(license_info.license_signature.begin(), license_info.license_signature.end());
	}
	return license::os::signature_sha256_hex(signature);
}

static LCC_EVENT_TYPE add_malformed_api_input_event(license::EventRegistry& er, const char* input_source,
													const char* input_name) {
	er.addEventWithSeverity(SVRT_ERROR, LICENSE_MALFORMED, input_source, input_name);
	return LICENSE_MALFORMED;
}

static LCC_EVENT_TYPE add_runtime_security_failure_event(license::EventRegistry& er, const LCC_EVENT_TYPE event_type,
														 const char* source, const char* detail) {
	er.addEventWithSeverity(SVRT_ERROR, event_type, source, detail);
	return event_type;
}

static bool normalize_decision_options(const LccLicenseDecisionOptions* options,
									   LccLicenseDecisionOptions& normalized, string& error) {
	lcc_init_license_decision_options(&normalized);
	if (options == nullptr) {
		return true;
	}
	if (options->size != sizeof(LccLicenseDecisionOptions)) {
		error = "invalid LccLicenseDecisionOptions size";
		return false;
	}
	if (options->version != LCC_LICENSE_DECISION_OPTIONS_VERSION) {
		error = "invalid LccLicenseDecisionOptions version";
		return false;
	}
	normalized = *options;
	normalized.size = sizeof(LccLicenseDecisionOptions);
	normalized.version = LCC_LICENSE_DECISION_OPTIONS_VERSION;
	if (normalized.online_timeout_ms == 0 || normalized.online_timeout_ms > LCC_ONLINE_MAX_TIMEOUT_MS) {
		error = "invalid online timeout";
		return false;
	}
	const size_t device_hash_size =
		license::mstrnlen_s(normalized.online_device_hash, sizeof(normalized.online_device_hash));
	if (device_hash_size == sizeof(normalized.online_device_hash)) {
		error = "online device hash is not NUL-terminated";
		return false;
	}
	if (device_hash_size != 0 &&
		(device_hash_size != LCC_API_ONLINE_DEVICE_HASH_SIZE ||
		 !is_public_hex_string(normalized.online_device_hash, device_hash_size))) {
		error = "invalid online device hash";
		return false;
	}
	return true;
}

static LicenseCheckOptions secure_decision_check_options(const LccLicenseDecisionOptions& options) {
	LicenseCheckOptions check_options;
	lcc_init_license_check_options(&check_options);
	check_options.tamper_policy = LCC_TAMPER_ENFORCE;
	check_options.tamper_flags = LCC_TAMPER_FLAG_STRICT_SOURCE_SHADOWING;
	check_options.host_integrity_check = options.host_integrity_check;
	check_options.host_integrity_user_data = options.host_integrity_user_data;
	check_options.online_policy = LCC_ONLINE_REQUIRE;
	check_options.online_flags = LCC_ONLINE_FLAG_NONE;
	check_options.online_timeout_ms = options.online_timeout_ms;
	check_options.online_check = options.online_check;
	check_options.online_user_data = options.online_user_data;
	license::mstrlcpy(check_options.online_device_hash, options.online_device_hash,
					   sizeof(check_options.online_device_hash));
	return check_options;
}

static bool call_revocation_floor_load(const RevocationFloorCallbacks& callbacks,
									   const LccRevocationFloorRecord& key, uint64_t& revocation_seq,
									   string& detail) {
	if (callbacks.load == nullptr) {
		detail = "revocation floor load callback is not configured";
		return false;
	}
	uint64_t loaded = 0;
	bool ok = false;
	try {
		ok = callbacks.load(callbacks.user_data, &key, &loaded);
	} catch (const std::exception& ex) {
		detail = ex.what();
		return false;
	} catch (...) {
		detail = "revocation floor load callback threw";
		return false;
	}
	if (!ok) {
		detail = "revocation floor load callback failed";
		return false;
	}
	revocation_seq = loaded;
	return true;
}

static bool call_revocation_floor_store(const RevocationFloorCallbacks& callbacks,
										const LccRevocationFloorRecord& record, string& detail) {
	if (callbacks.store == nullptr) {
		detail = "revocation floor store callback is not configured";
		return false;
	}
	bool ok = false;
	try {
		ok = callbacks.store(callbacks.user_data, &record);
	} catch (const std::exception& ex) {
		detail = ex.what();
		return false;
	} catch (...) {
		detail = "revocation floor store callback threw";
		return false;
	}
	if (!ok) {
		detail = "revocation floor store callback failed";
		return false;
	}
	return true;
}

static void export_license_status(license::EventRegistry& er, LicenseInfo* license_out) {
#ifndef NDEBUG
	const string evlog = er.to_string();
	LOG_DEBUG("License status %s", evlog.c_str());
#endif

	if (license_out != nullptr) {
		er.exportLastEvents(license_out->status, LCC_API_AUDIT_EVENT_NUM);
	}
}

static LCC_EVENT_TYPE acquire_license_internal(const CallerInformations* callerInformation,
											   const LicenseLocation* licenseLocation, LicenseInfo* license_out,
											   bool strict_source_fatal, license::EventRegistry& er,
											   AcquiredLicenseContext* context_out) {
	if (license_out != nullptr) {
		*license_out = LicenseInfo{};
	}
	if (context_out != nullptr) {
		*context_out = AcquiredLicenseContext{};
	}
	er = license::EventRegistry{};
	string project;
	if (callerInformation != nullptr) {
		const size_t feature_capacity = sizeof callerInformation->feature_name;
		const size_t feature_size = license::mstrnlen_s(callerInformation->feature_name, feature_capacity);
		if (feature_size == feature_capacity) {
			return add_malformed_api_input_event(er, "CallerInformations", "feature_name is not NUL-terminated");
		}
		const size_t version_capacity = sizeof callerInformation->version;
		const size_t version_size = license::mstrnlen_s(callerInformation->version, version_capacity);
		if (version_size == version_capacity) {
			return add_malformed_api_input_event(er, "CallerInformations", "version is not NUL-terminated");
		}
		if (feature_size > 0) {
			project = string(callerInformation->feature_name, feature_size);
		}
	}
	if (project.empty()) {
		project = string(LCC_PROJECT_NAME);
	}
	const license::LicenseReader lr = license::LicenseReader(licenseLocation);
	vector<license::FullLicenseInfo> licenses;
	try {
		er = lr.readLicenses(string(project), licenses);
	} catch (const std::exception& ex) {
		er.addEvent(LICENSE_MALFORMED, "LicenseReader", ex.what());
		er.turnWarningsIntoErrors();
	} catch (...) {
		er.addEvent(LICENSE_MALFORMED, "LicenseReader", "unexpected exception");
		er.turnWarningsIntoErrors();
	}
	LCC_EVENT_TYPE result;
	if (licenses.size() > 0) {
		vector<LicenseInfo> licenses_with_errors;
		vector<VerifiedLicenseCandidate> licenses_ok;
		license::LicenseVerifier verifier(er);
		for (auto full_lic_info_it = licenses.begin(); full_lic_info_it != licenses.end(); full_lic_info_it++) {
			try {
				if (callerInformation != nullptr) {
					full_lic_info_it->m_magic = callerInformation->magic;
				}
				const FUNCTION_RETURN signatureValid = verifier.verify_signature(*full_lic_info_it);
				if (signatureValid == FUNC_RET_OK) {
					const FUNCTION_RETURN limitsValid = verifier.verify_limits(*full_lic_info_it, callerInformation);
					LicenseInfo licInfo = verifier.toLicenseInfo(*full_lic_info_it);
					if (limitsValid == FUNC_RET_OK) {
						VerifiedLicenseCandidate candidate;
						candidate.info = licInfo;
						candidate.context.project = LCC_PROJECT_NAME;
						candidate.context.feature = project;
						candidate.context.license_fingerprint = fingerprint_for_license(*full_lic_info_it);
						licenses_ok.push_back(candidate);
					} else {
						licenses_with_errors.push_back(licInfo);
					}
				} else {
					LicenseInfo licInfo = verifier.toLicenseInfo(*full_lic_info_it);
					licenses_with_errors.push_back(licInfo);
				}
			} catch (const std::exception& ex) {
				er.addEvent(LICENSE_MALFORMED, full_lic_info_it->source.c_str(), ex.what());
				LicenseInfo licInfo{};
				licenses_with_errors.push_back(licInfo);
			}
		}
		if (licenses_ok.size() > 0) {
			const AuditEvent* strict_source_failure =
				strict_source_fatal ? license::anti_tamper::find_source_shadowing_signal(er) : nullptr;
			if (strict_source_failure != nullptr) {
				const LCC_EVENT_TYPE strict_event_type = strict_source_failure->event_type;
				const string strict_reference(strict_source_failure->license_reference);
				const string strict_info(strict_source_failure->param2);
				er.addEvent(strict_event_type, strict_reference.c_str(), strict_info.c_str());
				er.turnWarningsIntoErrors();
				result = strict_event_type;
			} else {
				er.turnErrorsIntoWarnings();
				result = LICENSE_OK;
				mergeVerifiedLicenses(licenses_ok, license_out, context_out);
			}
		} else {
			er.turnWarningsIntoErrors();
			const AuditEvent* failure = er.getLastFailure();
			result = failure != nullptr ? failure->event_type : PRODUCT_NOT_LICENSED;
			mergeLicenses(licenses_with_errors, license_out);
		}
	} else {
		er.turnWarningsIntoErrors();
		const AuditEvent* failure = er.getLastFailure();
		result = failure != nullptr ? failure->event_type : PRODUCT_NOT_LICENSED;
	}
	return result;
}

LCC_EVENT_TYPE acquire_license(const CallerInformations* callerInformation, const LicenseLocation* licenseLocation,
							   LicenseInfo* license_out) {
	license::EventRegistry er;
	const bool strict_source_fatal = strict_source_fatal_enabled.load(std::memory_order_relaxed);
	const LCC_EVENT_TYPE result =
		acquire_license_internal(callerInformation, licenseLocation, license_out, strict_source_fatal, er, nullptr);
	export_license_status(er, license_out);
	return result;
}

static LCC_EVENT_TYPE acquire_license_with_runtime_checks(const CallerInformations* callerInformation,
														  const LicenseLocation* licenseLocation,
														  LicenseInfo* license_out,
														  const LicenseCheckOptions& normalized_options,
														  const RevocationFloorCallbacks* floor_callbacks,
														  RuntimeHardeningStatus* hardening_out) {
	if (license_out != nullptr) {
		*license_out = LicenseInfo{};
	}
	if (hardening_out != nullptr) {
		*hardening_out = RuntimeHardeningStatus{};
		lcc_init_revocation_floor_record(&hardening_out->revocation_floor);
		hardening_out->tamper_enforced = normalized_options.tamper_policy == LCC_TAMPER_ENFORCE;
	}

	license::EventRegistry er;
	AcquiredLicenseContext license_context;
	LCC_EVENT_TYPE result =
		acquire_license_internal(callerInformation, licenseLocation, license_out, false, er, &license_context);
	// INVARIANT: runtime checks run ONLY after the base license returns LICENSE_OK, so an ordinary
	// license failure (expired/mismatch/malformed) is never masked or overwritten. Tamper under ENFORCE
	// and a failed required online check both fail closed (clear license_out, return the failure code).
	// Do not reorder these so a runtime check can run before the base verdict, or hide a base failure.
	if (result == LICENSE_OK) {
		license::anti_tamper::AntiTamperRequest request;
		request.policy = license::anti_tamper::to_internal_policy(normalized_options.tamper_policy);
		request.flags = normalized_options.tamper_flags;
		request.host_integrity_check = normalized_options.host_integrity_check;
		request.host_integrity_user_data = normalized_options.host_integrity_user_data;
		request.source_shadowing_event = license::anti_tamper::find_source_shadowing_signal(er);

		const license::anti_tamper::AntiTamperResult tamper_result = license::anti_tamper::evaluate(request);
		if (tamper_result.detected()) {
			license::anti_tamper::append_audit_events(tamper_result, er);
			if (tamper_result.policy == license::anti_tamper::AntiTamperPolicy::Enforce) {
				result = LICENSE_TAMPER_DETECTED;
			}
		}
	}
	if (result == LICENSE_OK) {
		const license::online_verification::OnlinePolicy online_policy =
			license::online_verification::to_internal_policy(normalized_options.online_policy);
		uint64_t minimum_revocation_seq = 0;
		LccRevocationFloorRecord loaded_floor{};
		bool loaded_floor_available = false;
		if (online_policy != license::online_verification::OnlinePolicy::Disabled &&
			floor_callbacks != nullptr) {
			string floor_error;
			if (!floor_record_from_context(license_context, 0, loaded_floor, floor_error)) {
				result = add_malformed_api_input_event(er, "RevocationFloor", floor_error.c_str());
			} else if (floor_callbacks->load == nullptr || floor_callbacks->store == nullptr) {
				result = add_runtime_security_failure_event(
					er, LICENSE_ONLINE_REQUIRED, "RevocationFloor",
					"revocation floor load/store callbacks are required");
			} else {
				string detail;
				if (!call_revocation_floor_load(*floor_callbacks, loaded_floor, minimum_revocation_seq, detail)) {
					result = add_runtime_security_failure_event(er, LICENSE_ONLINE_VERIFICATION_FAILED,
																"RevocationFloorLoad", detail.c_str());
				} else {
					loaded_floor_available = true;
					loaded_floor.revocation_seq = minimum_revocation_seq;
					if (hardening_out != nullptr) {
						hardening_out->revocation_floor_loaded = true;
						hardening_out->revocation_floor = loaded_floor;
					}
				}
			}
		}
		if (result != LICENSE_OK) {
			if (license_out != nullptr) {
				*license_out = LicenseInfo{};
			}
			export_license_status(er, license_out);
			return result;
		}
		license::online_verification::OnlineVerificationRequest request;
		request.policy = online_policy;
		request.flags = normalized_options.online_flags;
		request.timeout_ms = normalized_options.online_timeout_ms;
		request.online_check = normalized_options.online_check;
		request.online_user_data = normalized_options.online_user_data;
		request.project = license_context.project;
		request.feature = license_context.feature;
		request.license_fingerprint = license_context.license_fingerprint;
		request.device_hash = normalized_options.online_device_hash;
		if (loaded_floor_available) {
			request.minimum_revocation_seq = minimum_revocation_seq;
		}

		const license::online_verification::OnlineVerificationResult online_result =
			license::online_verification::evaluate(request);
		if (online_result.failed()) {
			license::online_verification::append_audit_event(online_result, er);
			if (!online_result.accepted) {
				result = online_result.event_type;
			}
		} else if (request.policy != license::online_verification::OnlinePolicy::Disabled) {
			if (hardening_out != nullptr) {
				hardening_out->online_verified = true;
			}
			if (floor_callbacks != nullptr) {
				LccRevocationFloorRecord accepted_floor{};
				string floor_error;
				if (!floor_record_from_context(license_context, online_result.accepted_revocation_seq,
											   accepted_floor, floor_error)) {
					result = add_malformed_api_input_event(er, "RevocationFloor", floor_error.c_str());
				} else {
					string detail;
					if (!call_revocation_floor_store(*floor_callbacks, accepted_floor, detail)) {
						result = add_runtime_security_failure_event(er, LICENSE_ONLINE_VERIFICATION_FAILED,
																	"RevocationFloorStore", detail.c_str());
					} else if (hardening_out != nullptr) {
						hardening_out->revocation_floor_stored = true;
						hardening_out->revocation_floor = accepted_floor;
					}
				}
			}
		}
	}

	if (result != LICENSE_OK && license_out != nullptr) {
		*license_out = LicenseInfo{};
	}
	export_license_status(er, license_out);
	return result;
}

LCC_EVENT_TYPE acquire_license_ex(const CallerInformations* callerInformation, const LicenseLocation* licenseLocation,
								  LicenseInfo* license_out, const LicenseCheckOptions* options) {
	if (license_out != nullptr) {
		*license_out = LicenseInfo{};
	}

	LicenseCheckOptions normalized_options;
	string options_error;
	license::EventRegistry er;
	if (!license::anti_tamper::normalize_options(options, normalized_options, options_error)) {
		add_malformed_api_input_event(er, "LicenseCheckOptions", options_error.c_str());
		export_license_status(er, license_out);
		return LICENSE_MALFORMED;
	}
	return acquire_license_with_runtime_checks(callerInformation, licenseLocation, license_out, normalized_options,
											   nullptr, nullptr);
}

static void populate_license_decision(LccLicenseDecision* decision_out, const LCC_EVENT_TYPE result,
									  const RuntimeHardeningStatus* hardening) {
	if (decision_out == nullptr) {
		return;
	}
	decision_out->decision = result == LICENSE_OK ? LCC_LICENSE_DECISION_ALLOW : LCC_LICENSE_DECISION_DENY;
	decision_out->event_type = result;
	if (hardening != nullptr) {
		decision_out->online_verified = hardening->online_verified;
		decision_out->revocation_floor_loaded = hardening->revocation_floor_loaded;
		decision_out->revocation_floor_stored = hardening->revocation_floor_stored;
		decision_out->tamper_enforced = hardening->tamper_enforced;
		decision_out->revocation_floor = hardening->revocation_floor;
	}
}

LCC_EVENT_TYPE lcc_acquire_license_decision(const CallerInformations* callerInformation,
											const LicenseLocation* licenseLocation, LicenseInfo* license_out,
											LccLicenseDecision* decision_out,
											const LccLicenseDecisionOptions* options) {
	if (license_out != nullptr) {
		*license_out = LicenseInfo{};
	}
	if (decision_out != nullptr) {
		lcc_init_license_decision(decision_out);
		decision_out->tamper_enforced = true;
	}

	LccLicenseDecisionOptions normalized_decision_options;
	string decision_options_error;
	license::EventRegistry er;
	if (!normalize_decision_options(options, normalized_decision_options, decision_options_error)) {
		const LCC_EVENT_TYPE result =
			add_malformed_api_input_event(er, "LccLicenseDecisionOptions", decision_options_error.c_str());
		export_license_status(er, license_out);
		populate_license_decision(decision_out, result, nullptr);
		return result;
	}
	if (normalized_decision_options.online_check == nullptr) {
		const LCC_EVENT_TYPE result = add_runtime_security_failure_event(
			er, LICENSE_ONLINE_REQUIRED, "LccLicenseDecisionOptions", "online callback is required");
		export_license_status(er, license_out);
		populate_license_decision(decision_out, result, nullptr);
		return result;
	}
	if (normalized_decision_options.revocation_floor_load == nullptr ||
		normalized_decision_options.revocation_floor_store == nullptr) {
		const LCC_EVENT_TYPE result = add_runtime_security_failure_event(
			er, LICENSE_ONLINE_REQUIRED, "LccLicenseDecisionOptions",
			"revocation floor load/store callbacks are required");
		export_license_status(er, license_out);
		populate_license_decision(decision_out, result, nullptr);
		return result;
	}

	LicenseCheckOptions check_options = secure_decision_check_options(normalized_decision_options);
	LicenseCheckOptions normalized_check_options;
	string check_options_error;
	if (!license::anti_tamper::normalize_options(&check_options, normalized_check_options, check_options_error)) {
		const LCC_EVENT_TYPE result =
			add_malformed_api_input_event(er, "LccLicenseDecisionOptions", check_options_error.c_str());
		export_license_status(er, license_out);
		populate_license_decision(decision_out, result, nullptr);
		return result;
	}

	RevocationFloorCallbacks floor_callbacks;
	floor_callbacks.load = normalized_decision_options.revocation_floor_load;
	floor_callbacks.store = normalized_decision_options.revocation_floor_store;
	floor_callbacks.user_data = normalized_decision_options.revocation_floor_user_data;

	RuntimeHardeningStatus hardening;
	const LCC_EVENT_TYPE result = acquire_license_with_runtime_checks(callerInformation, licenseLocation, license_out,
																	  normalized_check_options, &floor_callbacks,
																	  &hardening);
	populate_license_decision(decision_out, result, &hardening);
	return result;
}

bool lcc_set_online_revocation_floor(const LccRevocationFloorRecord* record) {
	string project;
	string feature;
	string license_fingerprint;
	string error;
	if (!floor_record_key_to_strings(record, project, feature, license_fingerprint, error)) {
		return false;
	}
	license::online_verification::set_revocation_floor(project, feature, license_fingerprint, record->revocation_seq);
	return true;
}

bool lcc_get_online_revocation_floor(LccRevocationFloorRecord* record) {
	string project;
	string feature;
	string license_fingerprint;
	string error;
	if (!floor_record_key_to_strings(record, project, feature, license_fingerprint, error)) {
		return false;
	}
	record->revocation_seq = license::online_verification::revocation_floor(project, feature, license_fingerprint);
	return true;
}

void lcc_set_environment_license_sources_enabled(bool enabled) {
	license::locate::LocatorFactory::find_license_with_env_var(enabled);
}

void lcc_set_strict_source_fatal_enabled(bool enabled) {
	strict_source_fatal_enabled.store(enabled, std::memory_order_relaxed);
}

LCC_EVENT_TYPE confirm_license(char* featureName, LicenseLocation* licenseLocation) {
	(void)featureName;
	(void)licenseLocation;
	return PRODUCT_NOT_LICENSED;
}

LCC_EVENT_TYPE release_license(char* featureName, LicenseLocation licenseLocation) {
	(void)featureName;
	(void)licenseLocation;
	return PRODUCT_NOT_LICENSED;
}
