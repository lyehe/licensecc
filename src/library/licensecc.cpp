//============================================================================
// Name        : licensecc.cpp
// Author      :
// Version     :
// Copyright   : BSD
//============================================================================

#define __STDC_WANT_LIB_EXT1__ 1
#include <fstream>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <cstring>
#include <iostream>

#include <licensecc/datatypes.h>
#include <licensecc/licensecc.h>
#include <licensecc_properties.h>

#include "base/logger.h"
#include "base/string_utils.h"
#include "hw_identifier/hw_identifier_facade.hpp"
#include "os/execution_environment.hpp"
#include "limits/license_verifier.hpp"
#include "base/string_utils.h"
#include "LicenseReader.hpp"

using namespace std;

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

void print_error(char out_buffer[LCC_API_ERROR_BUFFER_SIZE], LicenseInfo* licenseInfo) {
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

LCC_EVENT_TYPE acquire_license(const CallerInformations* callerInformation, const LicenseLocation* licenseLocation,
							   LicenseInfo* license_out) {
	const license::LicenseReader lr = license::LicenseReader(licenseLocation);
	vector<license::FullLicenseInfo> licenses;
	string project;
	size_t str_size;
	if (callerInformation != nullptr &&
		(str_size = license::mstrnlen_s(callerInformation->feature_name, sizeof callerInformation->feature_name)) > 0) {
		project = string(callerInformation->feature_name, str_size);
	} else {
		project = string(LCC_PROJECT_NAME);
	}
	license::EventRegistry er = lr.readLicenses(string(project), licenses);
	LCC_EVENT_TYPE result;
	if (licenses.size() > 0) {
		vector<LicenseInfo> licenses_with_errors;
		vector<LicenseInfo> licenses_ok;
		license::LicenseVerifier verifier(er);
		for (auto full_lic_info_it = licenses.begin(); full_lic_info_it != licenses.end(); full_lic_info_it++) {
			if (callerInformation != nullptr) {
				full_lic_info_it->m_magic = callerInformation->magic;
			}
			const FUNCTION_RETURN signatureValid = verifier.verify_signature(*full_lic_info_it);
			LicenseInfo licInfo = verifier.toLicenseInfo(*full_lic_info_it);
			if (signatureValid == FUNC_RET_OK) {
				if (verifier.verify_limits(*full_lic_info_it) == FUNC_RET_OK) {
					licenses_ok.push_back(licInfo);
				} else {
					licenses_with_errors.push_back(licInfo);
				}
			} else {
				licenses_with_errors.push_back(licInfo);
			}
		}
		if (licenses_ok.size() > 0) {
			er.turnErrorsIntoWarnings();
			result = LICENSE_OK;
			mergeLicenses(licenses_ok, license_out);
		} else {
			er.turnWarningsIntoErrors();
			result = er.getLastFailure()->event_type;
			mergeLicenses(licenses_with_errors, license_out);
		}
	} else {
		er.turnWarningsIntoErrors();
		result = er.getLastFailure()->event_type;
		if (license_out != nullptr) {
			license_out->proprietary_data[0] = '\0';
			license_out->linked_to_pc = false;
			license_out->days_left = 0;
		}
	}
#ifndef NDEBUG
	const string evlog = er.to_string();
	LOG_DEBUG("License status %s", evlog.c_str());
#endif

	if (license_out != nullptr) {
		er.exportLastEvents(license_out->status, LCC_API_AUDIT_EVENT_NUM);
	}
	return result;
}

LCC_EVENT_TYPE confirm_license(char* product, LicenseLocation licenseLocation) { return LICENSE_OK; }

LCC_EVENT_TYPE release_license(char* product, LicenseLocation licenseLocation) { return LICENSE_OK; }
