/*
 * LicenseVerifier.cpp
 *
 *  Created on: Nov 17, 2019
 *      Author: GC
 */
#include <cmath>
#include <cstdlib>
#include <algorithm>
#include <cctype>
#include <exception>
#include <stdexcept>
#include <sstream>
#include <vector>
#include <licensecc_properties.h>

#include "license_verifier.hpp"
#include "../base/base64.h"
#include "../base/string_utils.h"
#include "../base/v201_canonical_payload.hpp"
#include "../os/signature_verifier.hpp"
#include "../hw_identifier/hw_identifier_facade.hpp"
#include "../hw_identifier/hw_identifier.hpp"

namespace license {
using namespace std;

// days_left reported to the caller for a license that never expires.
static const unsigned int LCC_NO_EXPIRY_DAYS_LEFT = 9999;

LicenseVerifier::LicenseVerifier(EventRegistry& er) : m_event_registry(er) {}

LicenseVerifier::~LicenseVerifier() {}

static string limit_value_or_empty(const FullLicenseInfo& licInfo, const string& key) {
	const auto found = licInfo.m_limits.find(key);
	return found == licInfo.m_limits.end() ? string() : found->second;
}

static void add_v201_field(vector<license::v201::CanonicalField>& fields, const string& key, const string& value) {
	if (!value.empty()) {
		fields.push_back({key, value});
	}
}

static vector<license::v201::CanonicalField> v201_fields_for(const FullLicenseInfo& licInfo) {
	vector<license::v201::CanonicalField> fields;
	add_v201_field(fields, LICENSE_VERSION, limit_value_or_empty(licInfo, LICENSE_VERSION));
	add_v201_field(fields, LICENSE_CANONICAL_VERSION, limit_value_or_empty(licInfo, LICENSE_CANONICAL_VERSION));
	add_v201_field(fields, LICENSE_SIGNATURE_VERSION, limit_value_or_empty(licInfo, LICENSE_SIGNATURE_VERSION));
	add_v201_field(fields, LICENSE_SIGNATURE_ALGORITHM, limit_value_or_empty(licInfo, LICENSE_SIGNATURE_ALGORITHM));
	add_v201_field(fields, LICENSE_KEY_ID, limit_value_or_empty(licInfo, LICENSE_KEY_ID));
	add_v201_field(fields, "project", LCC_PROJECT_NAME);
	add_v201_field(fields, "feature", toupper_copy(trim_copy(licInfo.m_project)));
	add_v201_field(fields, PARAM_BEGIN_DATE, limit_value_or_empty(licInfo, PARAM_BEGIN_DATE));
	add_v201_field(fields, PARAM_EXPIRY_DATE, limit_value_or_empty(licInfo, PARAM_EXPIRY_DATE));
	add_v201_field(fields, PARAM_VERSION_FROM, limit_value_or_empty(licInfo, PARAM_VERSION_FROM));
	add_v201_field(fields, PARAM_VERSION_TO, limit_value_or_empty(licInfo, PARAM_VERSION_TO));
	add_v201_field(fields, PARAM_CLIENT_SIGNATURE, limit_value_or_empty(licInfo, PARAM_CLIENT_SIGNATURE));
	add_v201_field(fields, PARAM_CLIENT_SIGNATURE_SOURCE_STRENGTH,
				   limit_value_or_empty(licInfo, PARAM_CLIENT_SIGNATURE_SOURCE_STRENGTH));
	add_v201_field(fields, PARAM_EXTRA_DATA, limit_value_or_empty(licInfo, PARAM_EXTRA_DATA));
	return fields;
}

static bool is_v201_license(const FullLicenseInfo& licInfo) {
	return limit_value_or_empty(licInfo, LICENSE_VERSION) == to_string(LCC_LICENSE_FORMAT_VERSION_V201);
}

FUNCTION_RETURN LicenseVerifier::verify_signature(const FullLicenseInfo& licInfo) {
	const bool is_v201 = is_v201_license(licInfo);
	license::os::SignatureVerificationRequest request;
	request.signature = unbase64(licInfo.license_signature);
	if (is_v201) {
		const license::v201::CanonicalPayloadResult canonical =
			license::v201::build_canonical_payload(v201_fields_for(licInfo));
		if (!canonical.ok) {
			m_event_registry.addEvent(LICENSE_MALFORMED, licInfo.source.c_str(), canonical.error.c_str());
			return FUNC_RET_ERROR;
		}
		request.payload = canonical.bytes;
		request.declared_algorithm = limit_value_or_empty(licInfo, LICENSE_SIGNATURE_ALGORITHM);
		request.key_id = limit_value_or_empty(licInfo, LICENSE_KEY_ID);
		request.license_version = LCC_LICENSE_FORMAT_VERSION_V201;
		request.policy = license::os::current_v201_signature_policy();
	} else {
		const string licInfoData(licInfo.printForSign());
		request.payload.assign(licInfoData.begin(), licInfoData.end());
		request.declared_algorithm = license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256;
		request.key_id = license::os::embedded_public_key_id();
		request.license_version = LCC_LICENSE_FORMAT_VERSION_V200;
		request.policy = license::os::legacy_v200_signature_policy();
	}

	FUNCTION_RETURN ret = license::os::verify_signature(request);

	if (ret == FUNC_RET_OK) {
		m_event_registry.addEvent(SIGNATURE_VERIFIED, licInfo.source);
	} else {
		m_event_registry.addEvent(LICENSE_CORRUPTED, licInfo.source);
	}
	return ret;
}

static bool parse_version(const string& version, vector<unsigned int>& out) {
	if (version.empty() || version.front() == '.' || version.back() == '.') {
		return false;
	}
	string segment;
	stringstream ss(version);
	while (getline(ss, segment, '.')) {
		if (segment.empty() || segment.size() > 4 || out.size() >= 3) {
			return false;
		}
		unsigned int value = 0;
		for (const char ch : segment) {
			if (!isdigit(static_cast<unsigned char>(ch))) {
				return false;
			}
			value = value * 10 + static_cast<unsigned int>(ch - '0');
		}
		out.push_back(value);
	}
	return !out.empty();
}

static int compare_versions(const vector<unsigned int>& lhs, const vector<unsigned int>& rhs) {
	const size_t max_size = max(lhs.size(), rhs.size());
	for (size_t i = 0; i < max_size; ++i) {
		const unsigned int l = i < lhs.size() ? lhs[i] : 0;
		const unsigned int r = i < rhs.size() ? rhs[i] : 0;
		if (l < r) {
			return -1;
		}
		if (l > r) {
			return 1;
		}
	}
	return 0;
}

static bool has_version_limit(const FullLicenseInfo& lic_info) {
	return lic_info.m_limits.find(PARAM_VERSION_FROM) != lic_info.m_limits.end() ||
		   lic_info.m_limits.find(PARAM_VERSION_TO) != lic_info.m_limits.end();
}

static bool validate_v201_client_signature_source_strength(const FullLicenseInfo& lic_info,
														   EventRegistry& event_registry) {
	if (!is_v201_license(lic_info)) {
		return true;
	}
	const auto client_sig = lic_info.m_limits.find(PARAM_CLIENT_SIGNATURE);
	if (client_sig == lic_info.m_limits.end()) {
		if (lic_info.m_limits.find(PARAM_CLIENT_SIGNATURE_SOURCE_STRENGTH) != lic_info.m_limits.end()) {
			event_registry.addEvent(LICENSE_MALFORMED, lic_info.source.c_str(),
									"client-signature-source-strength requires client-signature");
			return false;
		}
		return true;
	}
	const auto source_strength = lic_info.m_limits.find(PARAM_CLIENT_SIGNATURE_SOURCE_STRENGTH);
	if (source_strength == lic_info.m_limits.end() || source_strength->second.empty()) {
		event_registry.addEvent(LICENSE_MALFORMED, lic_info.source.c_str(),
								"client-signature-source-strength is required for v201 hardware binding");
		return false;
	}
	try {
		const hw_identifier::HwIdentifier identifier(client_sig->second);
		const string expected = identifier.source_strength_metadata();
		if (source_strength->second != expected) {
			event_registry.addEvent(LICENSE_MALFORMED, lic_info.source.c_str(),
									"client-signature-source-strength does not match client-signature");
			return false;
		}
	} catch (const logic_error&) {
		event_registry.addEvent(LICENSE_MALFORMED, lic_info.source.c_str(),
								"client-signature is malformed or unsupported");
		return false;
	}
	return true;
}

static bool validate_extra_data_value(const string& extra_data, string& error) {
	if (extra_data.empty()) {
		error = "extra-data must not be empty";
		return false;
	}
	if (extra_data.size() > LCC_API_PROPRIETARY_DATA_SIZE) {
		error = "extra-data exceeds public API buffer size";
		return false;
	}
	if (isspace(static_cast<unsigned char>(extra_data.front())) ||
		isspace(static_cast<unsigned char>(extra_data.back()))) {
		error = "extra-data must not start or end with whitespace";
		return false;
	}
	for (const unsigned char ch : extra_data) {
		if (iscntrl(ch)) {
			error = "extra-data must not contain control characters";
			return false;
		}
	}
	return true;
}

// TODO: split in different classes
FUNCTION_RETURN LicenseVerifier::verify_limits(const FullLicenseInfo& lic_info,
											   const CallerInformations* callerInformation) {
	bool is_valid = LCC_VERIFY_MAGIC;
	if (!is_valid) {
		m_event_registry.addEvent(LICENSE_CORRUPTED, lic_info.source.c_str());
	}
	const time_t now = time(nullptr);
	auto expiry = lic_info.m_limits.find(PARAM_EXPIRY_DATE);
	if (is_valid && expiry != lic_info.m_limits.end()) {
		try {
			if (seconds_from_epoch(expiry->second) < now) {
				m_event_registry.addEvent(PRODUCT_EXPIRED, lic_info.source.c_str(),
										  ("Expired " + expiry->second).c_str());
				is_valid = false;
			}
		} catch (const std::exception&) {
			m_event_registry.addEvent(LICENSE_MALFORMED, lic_info.source.c_str(),
									  ("Invalid " PARAM_EXPIRY_DATE " " + expiry->second).c_str());
			is_valid = false;
		}
	}
	const auto start_date = lic_info.m_limits.find(PARAM_BEGIN_DATE);
	if (is_valid && start_date != lic_info.m_limits.end()) {
		try {
			if (seconds_from_epoch(start_date->second) > now) {
				m_event_registry.addEvent(PRODUCT_EXPIRED, lic_info.source.c_str(),
										  ("Valid from " + start_date->second).c_str());
				is_valid = false;
			}
		} catch (const std::exception&) {
			m_event_registry.addEvent(LICENSE_MALFORMED, lic_info.source.c_str(),
									  ("Invalid " PARAM_BEGIN_DATE " " + start_date->second).c_str());
			is_valid = false;
		}
	}
	if (is_valid && has_version_limit(lic_info)) {
		vector<unsigned int> caller_version;
		if (callerInformation == nullptr) {
			m_event_registry.addEvent(PRODUCT_NOT_LICENSED, lic_info.source.c_str(), "Caller version not provided");
			is_valid = false;
		} else {
			const size_t version_capacity = sizeof callerInformation->version;
			const size_t version_size = mstrnlen_s(callerInformation->version, version_capacity);
			if (version_size == version_capacity) {
				m_event_registry.addEvent(LICENSE_MALFORMED, lic_info.source.c_str(),
										  "Caller version is not NUL-terminated");
				is_valid = false;
			} else if (!parse_version(string(callerInformation->version, version_size), caller_version)) {
				m_event_registry.addEvent(PRODUCT_NOT_LICENSED, lic_info.source.c_str(), "Caller version malformed");
				is_valid = false;
			}
		}
		const auto version_from = lic_info.m_limits.find(PARAM_VERSION_FROM);
		if (is_valid && version_from != lic_info.m_limits.end()) {
			vector<unsigned int> from;
			if (!parse_version(version_from->second, from)) {
				m_event_registry.addEvent(LICENSE_MALFORMED, lic_info.source.c_str(),
										  ("Invalid " PARAM_VERSION_FROM " " + version_from->second).c_str());
				is_valid = false;
			} else if (compare_versions(caller_version, from) < 0) {
				m_event_registry.addEvent(PRODUCT_NOT_LICENSED, lic_info.source.c_str(),
										  ("Version before " + version_from->second).c_str());
				is_valid = false;
			}
		}
		const auto version_to = lic_info.m_limits.find(PARAM_VERSION_TO);
		if (is_valid && version_to != lic_info.m_limits.end()) {
			vector<unsigned int> to;
			if (!parse_version(version_to->second, to)) {
				m_event_registry.addEvent(LICENSE_MALFORMED, lic_info.source.c_str(),
										  ("Invalid " PARAM_VERSION_TO " " + version_to->second).c_str());
				is_valid = false;
			} else if (compare_versions(caller_version, to) > 0) {
				m_event_registry.addEvent(PRODUCT_NOT_LICENSED, lic_info.source.c_str(),
										  ("Version after " + version_to->second).c_str());
				is_valid = false;
			}
		}
	}
	const auto client_sig = lic_info.m_limits.find(PARAM_CLIENT_SIGNATURE);
	if (is_valid && client_sig != lic_info.m_limits.end()) {
		if (!validate_v201_client_signature_source_strength(lic_info, m_event_registry)) {
			is_valid = false;
		} else {
			const LCC_EVENT_TYPE event = hw_identifier::HwIdentifierFacade::validate_pc_signature(client_sig->second);
			m_event_registry.addEvent(event, lic_info.source);
			is_valid = is_valid && (event == LICENSE_OK);
		}
	}
	const auto extra_data = lic_info.m_limits.find(PARAM_EXTRA_DATA);
	if (is_valid && extra_data != lic_info.m_limits.end()) {
		string error;
		if (!validate_extra_data_value(extra_data->second, error)) {
			m_event_registry.addEvent(LICENSE_MALFORMED, lic_info.source.c_str(), error.c_str());
			is_valid = false;
		}
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
		try {
			const double secs = difftime(seconds_from_epoch(expiry->second), time(nullptr));
			info.days_left = max((int)round(secs / (60 * 60 * 24)), 0);
		} catch (const std::exception&) {
			info.days_left = 0;
		}
	} else {
		info.has_expiry = false;
		info.days_left = LCC_NO_EXPIRY_DAYS_LEFT;
		info.expiry_date[0] = '\0';
	}

	const auto client_sig = fullLicInfo.m_limits.find(PARAM_CLIENT_SIGNATURE);
	info.linked_to_pc = (client_sig != fullLicInfo.m_limits.end());

	const auto proprietary_data = fullLicInfo.m_limits.find(PARAM_EXTRA_DATA);
	if (proprietary_data != fullLicInfo.m_limits.end()) {
		string error;
		if (validate_extra_data_value(proprietary_data->second, error)) {
			mstrlcpy(info.proprietary_data, proprietary_data->second.c_str(), sizeof(info.proprietary_data));
		}
	}
	return info;
}

} /* namespace license */
