/*
 * LicenseVerifier.cpp
 *
 *  Created on: Nov 17, 2019
 *      Author: GC
 */
#include <cmath>
#include <cstdlib>
#include <algorithm>
#include <licensecc_properties.h>

#include "license_verifier.hpp"
#include "../base/string_utils.h"
#include "../os/signature_verifier.hpp"
#include "../hw_identifier/hw_identifier_facade.hpp"

namespace license {
using namespace std;

// days_left reported to the caller for a license that never expires.
static const unsigned int LCC_NO_EXPIRY_DAYS_LEFT = 9999;

LicenseVerifier::LicenseVerifier(EventRegistry& er) : m_event_registry(er) {}

LicenseVerifier::~LicenseVerifier() {}

FUNCTION_RETURN LicenseVerifier::verify_signature(const FullLicenseInfo& licInfo) {
	const string licInfoData(licInfo.printForSign());

	FUNCTION_RETURN ret = license::os::verify_signature(licInfoData, licInfo.license_signature);

	if (ret == FUNC_RET_OK) {
		m_event_registry.addEvent(SIGNATURE_VERIFIED, licInfo.source);
	} else {
		m_event_registry.addEvent(LICENSE_CORRUPTED, licInfo.source);
	}
	return ret;
}

// TODO: split in different classes
FUNCTION_RETURN LicenseVerifier::verify_limits(const FullLicenseInfo& lic_info) {
	bool is_valid = LCC_VERIFY_MAGIC;
	if (!is_valid) {
		m_event_registry.addEvent(LICENSE_CORRUPTED, lic_info.source.c_str());
	}
	const time_t now = time(nullptr);
	auto expiry = lic_info.m_limits.find(PARAM_EXPIRY_DATE);
	if (is_valid && expiry != lic_info.m_limits.end()) {
		if (seconds_from_epoch(expiry->second) < now) {
			m_event_registry.addEvent(PRODUCT_EXPIRED, lic_info.source.c_str(), ("Expired " + expiry->second).c_str());
			is_valid = false;
		}
	}
	const auto start_date = lic_info.m_limits.find(PARAM_BEGIN_DATE);
	if (is_valid && start_date != lic_info.m_limits.end()) {
		if (seconds_from_epoch(start_date->second) > now) {
			m_event_registry.addEvent(PRODUCT_EXPIRED, lic_info.source.c_str(),
									  ("Valid from " + start_date->second).c_str());
			is_valid = false;
		}
	}
	const auto client_sig = lic_info.m_limits.find(PARAM_CLIENT_SIGNATURE);
	if (is_valid && client_sig != lic_info.m_limits.end()) {
		const LCC_EVENT_TYPE event = hw_identifier::HwIdentifierFacade::validate_pc_signature(client_sig->second);
		m_event_registry.addEvent(event, lic_info.source);
		is_valid = is_valid && (event == LICENSE_OK);
	}
	return is_valid ? FUNC_RET_OK : FUNC_RET_ERROR;
}

LicenseInfo LicenseVerifier::toLicenseInfo(const FullLicenseInfo& fullLicInfo) const {
	LicenseInfo info{};
	info.license_type = LCC_LOCAL;

	const auto license_version = fullLicInfo.m_limits.find(LICENSE_VERSION);
	if (license_version != fullLicInfo.m_limits.end()) {
		info.license_version = atoi(license_version->second.c_str());
	}

	const auto expiry = fullLicInfo.m_limits.find(PARAM_EXPIRY_DATE);
	if (expiry != fullLicInfo.m_limits.end()) {
		mstrlcpy(info.expiry_date, expiry->second.c_str(), sizeof(info.expiry_date));
		info.has_expiry = true;
		const double secs = difftime(seconds_from_epoch(expiry->second), time(nullptr));
		info.days_left = max((int)round(secs / (60 * 60 * 24)), 0);
	} else {
		info.has_expiry = false;
		info.days_left = LCC_NO_EXPIRY_DAYS_LEFT;
		info.expiry_date[0] = '\0';
	}

	const auto client_sig = fullLicInfo.m_limits.find(PARAM_CLIENT_SIGNATURE);
	info.linked_to_pc = (client_sig != fullLicInfo.m_limits.end());

	const auto proprietary_data = fullLicInfo.m_limits.find(PARAM_EXTRA_DATA);
	if (proprietary_data != fullLicInfo.m_limits.end()) {
		mstrlcpy(info.proprietary_data, proprietary_data->second.c_str(), sizeof(info.proprietary_data));
	}
	return info;
}

} /* namespace license */
