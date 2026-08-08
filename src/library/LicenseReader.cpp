/*
 * LicenseReader.cpp
 *
 *  Created on: Mar 30, 2014
 *
 */

#ifdef _WIN32
#pragma warning(disable : 4786)
#else
#include <unistd.h>
#endif

#include <cstring>
#include <ctime>
#include <vector>
#include <iostream>
#include <iterator>
#include <fstream>
#include <sstream>
#include <algorithm>
#include <cctype>
#include <exception>
#include <set>

#include <stdlib.h>
#include <math.h>

#include <licensecc/licensecc.h>

#include "base/base.h"
#include "base/base64.h"
#include "LicenseReader.hpp"
#include "base/string_utils.h"
#include "base/logger.h"
#include "locate/LocatorFactory.hpp"

namespace license {
using namespace std;

static string lowercase_copy(const string &value) {
	string result(value);
	transform(result.begin(), result.end(), result.begin(),
			  [](unsigned char ch) { return static_cast<char>(tolower(ch)); });
	return result;
}

static bool is_valid_base64(const string &value) {
	return is_canonical_base64(value, false);
}

static bool is_valid_v200_license_version(const char *value_raw) {
	return value_raw != nullptr && string(value_raw) == "200";
}

static bool is_valid_v201_license_version(const char *value_raw) {
	return value_raw != nullptr && string(value_raw) == "201";
}

static bool is_valid_version_limit(const string &value) {
	if (value.empty()) {
		return false;
	}
	size_t component_count = 0;
	size_t component_size = 0;
	for (const char ch : value) {
		if (ch == '.') {
			if (component_size == 0 || component_size > 4) {
				return false;
			}
			++component_count;
			component_size = 0;
			if (component_count >= 3) {
				return false;
			}
			continue;
		}
		if (!isdigit(static_cast<unsigned char>(ch))) {
			return false;
		}
		++component_size;
	}
	return component_size > 0 && component_size <= 4;
}

static const set<string> &v200_allowed_keys() {
	static const set<string> allowed_keys = {LICENSE_VERSION,		 PARAM_BEGIN_DATE,	 PARAM_EXPIRY_DATE,
											 PARAM_CLIENT_SIGNATURE, PARAM_VERSION_FROM, PARAM_VERSION_TO,
											 PARAM_EXTRA_DATA,		 LICENSE_SIGNATURE};
	return allowed_keys;
}

static const set<string> &v201_allowed_keys() {
	static const set<string> allowed_keys = {
		LICENSE_VERSION,	   LICENSE_CANONICAL_VERSION,	 LICENSE_SIGNATURE_VERSION,
		LICENSE_SIGNATURE_ALGORITHM, LICENSE_KEY_ID,			 PARAM_BEGIN_DATE,
		PARAM_EXPIRY_DATE,	   PARAM_CLIENT_SIGNATURE,		 PARAM_CLIENT_SIGNATURE_SOURCE_STRENGTH,
		PARAM_VERSION_FROM,	   PARAM_VERSION_TO,			 PARAM_EXTRA_DATA,
		LICENSE_SIGNATURE};
	return allowed_keys;
}

static bool validate_raw_value_shapes(const string &license_text, const string &product_up, const string &source,
									  EventRegistry &eventRegistry, const set<string> &allowed_keys) {
	istringstream lines(license_text);
	string line;
	bool in_product_section = false;
	bool product_section_seen = false;
	while (getline(lines, line)) {
		if (!line.empty() && line[line.size() - 1] == '\r') {
			line.erase(line.size() - 1);
		}
		const string trimmed_line = trim_copy(line);
		if (trimmed_line.empty() || trimmed_line[0] == ';' || trimmed_line[0] == '#') {
			continue;
		}
		if (trimmed_line.size() >= 2 && trimmed_line[0] == '[' && trimmed_line[trimmed_line.size() - 1] == ']') {
			const string section = trim_copy(trimmed_line.substr(1, trimmed_line.size() - 2));
			in_product_section = (toupper_copy(section) == product_up);
			if (in_product_section) {
				if (product_section_seen) {
					eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(), "Duplicate license section");
					return false;
				}
				product_section_seen = true;
			}
			continue;
		}
		if (!in_product_section) {
			continue;
		}
		const size_t separator = line.find('=');
		if (separator == string::npos) {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(), "Invalid license line");
			return false;
		}
		const string raw_key = line.substr(0, separator);
		const string trimmed_key = trim_copy(raw_key);
		if (trimmed_key.empty()) {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(), "Empty license key");
			return false;
		}
		const string key = lowercase_copy(trimmed_key);
		if (trimmed_key != key) {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(), ("Non-canonical license key " + trimmed_key).c_str());
			return false;
		}
		if (raw_key != key && raw_key != key + " ") {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(),
								   ("Non-canonical key spacing for " + key).c_str());
			return false;
		}
		if (allowed_keys.find(key) == allowed_keys.end()) {
			continue;
		}
		string raw_value = line.substr(separator + 1);
		if (!raw_value.empty() && raw_value[0] == ' ') {
			raw_value.erase(0, 1);
		}
		if (raw_value != trim_copy(raw_value)) {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(),
								   ("Non-canonical value spacing for " + key).c_str());
			return false;
		}
	}
	return true;
}

static bool validate_v200_raw_value_shapes(const string &license_text, const string &product_up,
										   const string &source, EventRegistry &eventRegistry) {
	return validate_raw_value_shapes(license_text, product_up, source, eventRegistry, v200_allowed_keys());
}

static bool validate_v201_raw_value_shapes(const string &license_text, const string &product_up,
										   const string &source, EventRegistry &eventRegistry) {
	return validate_raw_value_shapes(license_text, product_up, source, eventRegistry, v201_allowed_keys());
}

static bool validate_v200_section(CSimpleIniA &ini, const char *productNamePtr, const string &source,
								  EventRegistry &eventRegistry, CSimpleIniA::TNamesDepend &keys) {
	set<string> seen_keys;
	for (const auto &key_entry : keys) {
		const string key = trim_copy(key_entry.pItem);
		const string key_lower = lowercase_copy(key);
		if (key != key_lower || v200_allowed_keys().find(key) == v200_allowed_keys().end()) {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(), ("Unexpected license key " + key).c_str());
			return false;
		}
		if (!seen_keys.insert(key_lower).second) {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(), ("Duplicate license key " + key).c_str());
			return false;
		}

		CSimpleIniA::TNamesDepend values;
		ini.GetAllValues(productNamePtr, key_entry.pItem, values);
		if (values.size() != 1) {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(), ("Duplicate license key " + key).c_str());
			return false;
		}

		const char *value_raw = ini.GetValue(productNamePtr, key_entry.pItem, nullptr);
		const string value = value_raw == nullptr ? string() : trim_copy(value_raw);
		if (key == LICENSE_VERSION && !is_valid_v200_license_version(value_raw)) {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(), "Invalid license format version");
			return false;
		}
		if (key == LICENSE_SIGNATURE && !is_valid_base64(value)) {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(), "Invalid license signature encoding");
			return false;
		}
		if ((key == PARAM_BEGIN_DATE || key == PARAM_EXPIRY_DATE) && !is_canonical_v200_date(value)) {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(), ("Invalid date for " + key).c_str());
			return false;
		}
		if ((key == PARAM_VERSION_FROM || key == PARAM_VERSION_TO) && !is_valid_version_limit(value)) {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(), ("Invalid version for " + key).c_str());
			return false;
		}
	}
	return true;
}

static bool validate_v201_section(CSimpleIniA &ini, const char *productNamePtr, const string &source,
								  EventRegistry &eventRegistry, CSimpleIniA::TNamesDepend &keys) {
	set<string> seen_keys;
	for (const auto &key_entry : keys) {
		const string key = trim_copy(key_entry.pItem);
		const string key_lower = lowercase_copy(key);
		if (key != key_lower || v201_allowed_keys().find(key) == v201_allowed_keys().end()) {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(), ("Unexpected license key " + key).c_str());
			return false;
		}
		if (!seen_keys.insert(key_lower).second) {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(), ("Duplicate license key " + key).c_str());
			return false;
		}

		CSimpleIniA::TNamesDepend values;
		ini.GetAllValues(productNamePtr, key_entry.pItem, values);
		if (values.size() != 1) {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(), ("Duplicate license key " + key).c_str());
			return false;
		}

		const char *value_raw = ini.GetValue(productNamePtr, key_entry.pItem, nullptr);
		const string value = value_raw == nullptr ? string() : trim_copy(value_raw);
		if (key == LICENSE_VERSION && !is_valid_v201_license_version(value_raw)) {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(), "Invalid license format version");
			return false;
		}
		if (key == LICENSE_SIGNATURE && !is_valid_base64(value)) {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(), "Invalid license signature encoding");
			return false;
		}
	}
	for (const string &required_key : {string(LICENSE_VERSION), string(LICENSE_CANONICAL_VERSION),
									  string(LICENSE_SIGNATURE_VERSION), string(LICENSE_SIGNATURE_ALGORITHM),
									  string(LICENSE_KEY_ID), string(LICENSE_SIGNATURE)}) {
		if (seen_keys.find(required_key) == seen_keys.end()) {
			eventRegistry.addEvent(LICENSE_MALFORMED, source.c_str(),
								   ("Missing v201 license key " + required_key).c_str());
			return false;
		}
	}
	return true;
}

FullLicenseInfo::FullLicenseInfo(const string &source, const string &product, const string &license_signature)
	: source(source),
	  m_project(product),  //
	  license_signature(license_signature),
	  m_magic(0) {}

LicenseReader::LicenseReader(const LicenseLocation *licenseLocation) : licenseLocation(licenseLocation) {}

EventRegistry LicenseReader::readLicenses(const string &product, vector<FullLicenseInfo> &licenseInfoOut) const {
	vector<unique_ptr<locate::LocatorStrategy>> locator_strategies;
	FUNCTION_RETURN ret = locate::LocatorFactory::get_active_strategies(locator_strategies, licenseLocation);
	EventRegistry eventRegistry;
	if (ret != FUNC_RET_OK) {
		eventRegistry.addEvent(LICENSE_FILE_NOT_FOUND);
		eventRegistry.turnWarningsIntoErrors();
		return eventRegistry;
	}

	bool atLeastOneLicenseComplete = false;
	const string product_up = toupper_copy(product);
	const char *productNamePtr = product_up.c_str();
	for (unique_ptr<locate::LocatorStrategy> &locator : locator_strategies) {
		vector<string> licenseLocations = locator->license_locations(eventRegistry);
		if (licenseLocations.size() == 0) {
			continue;
		}
		CSimpleIniA ini;
		for (auto it = licenseLocations.begin(); it != licenseLocations.end(); it++) {
			ini.Reset();
			ini.SetMultiKey(true);
			const string license = locator->retrieve_license_content((*it).c_str());
			if (license.find('\0') != string::npos) {
				eventRegistry.addEvent(LICENSE_MALFORMED, it->c_str(), "License contains embedded NUL");
				continue;
			}
			const SI_Error rc = ini.LoadData(license.c_str(), license.size());
			if (rc < 0) {
				eventRegistry.addEvent(FILE_FORMAT_NOT_RECOGNIZED, *it);
				continue;
			}
			const int sectionSize = ini.GetSectionSize(productNamePtr);
			if (sectionSize <= 0) {
				eventRegistry.addEvent(PRODUCT_NOT_LICENSED, *it);
				continue;
			} else {
				eventRegistry.addEvent(PRODUCT_FOUND, *it);
			}
			/*
			 *  sw_version_from = (optional int)
			 *  sw_version_to = (optional int)
			 *  from_date = YYYY-MM-DD (optional)
			 *  to_date  = YYYY-MM-DD (optional)
			 *  client_signature = XXXX-XXXX-XXXX (optional string 16)
			 *  sig = XXXXXXXXXX (mandatory, 1024)
			 *  application_data = xxxxxxxxx (optional string 16)
			 */
			const char *license_signature = ini.GetValue(productNamePtr, LICENSE_SIGNATURE, nullptr);
			const char *license_version_raw = ini.GetValue(productNamePtr, LICENSE_VERSION, nullptr);
			const string license_version = license_version_raw == nullptr ? string() : string(license_version_raw);
			if (license_signature != nullptr && license_version == to_string(LCC_LICENSE_FORMAT_VERSION_V200)) {
				if (!validate_v200_raw_value_shapes(license, product_up, *it, eventRegistry)) {
					continue;
				}
				CSimpleIniA::TNamesDepend keys;
				ini.GetAllKeys(productNamePtr, keys);
				if (!validate_v200_section(ini, productNamePtr, *it, eventRegistry, keys)) {
					continue;
				}
				FullLicenseInfo licInfo(*it, product, license_signature);
				for (auto &it : keys) {
					licInfo.m_limits[it.pItem] = ini.GetValue(productNamePtr, it.pItem, nullptr);
				}
				licenseInfoOut.push_back(licInfo);
				atLeastOneLicenseComplete = true;
			} else if (license_signature != nullptr &&
					   license_version == to_string(LCC_LICENSE_FORMAT_VERSION_V201)) {
				if (!validate_v201_raw_value_shapes(license, product_up, *it, eventRegistry)) {
					continue;
				}
				CSimpleIniA::TNamesDepend keys;
				ini.GetAllKeys(productNamePtr, keys);
				if (!validate_v201_section(ini, productNamePtr, *it, eventRegistry, keys)) {
					continue;
				}
				FullLicenseInfo licInfo(*it, product, license_signature);
				for (auto &it : keys) {
					licInfo.m_limits[it.pItem] = ini.GetValue(productNamePtr, it.pItem, nullptr);
				}
				licenseInfoOut.push_back(licInfo);
				atLeastOneLicenseComplete = true;
			} else {
				eventRegistry.addEvent(LICENSE_MALFORMED, it->c_str(), "Invalid license format version");
			}
		}
	}
	if (!atLeastOneLicenseComplete) {
		eventRegistry.turnWarningsIntoErrors();
	}
	return eventRegistry;
}

LicenseReader::~LicenseReader() {}

string FullLicenseInfo::printForSign() const {
	ostringstream oss;
	oss << toupper_copy(trim_copy(m_project));
	for (auto &it : m_limits) {
		if (it.first != LICENSE_SIGNATURE) {
			oss << trim_copy(it.first) << trim_copy(it.second);
		}
	}

	LOG_DEBUG("license to sign [%s]", oss.str().c_str());
	return oss.str();
}

}  // namespace license
