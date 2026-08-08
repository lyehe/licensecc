/*
 * ExplicitDefinition.cpp
 *
 *  Created on: Oct 12, 2019
 *      Author: Gabriele Contini
 */

#include <stdlib.h>
#include <cstring>
#include <string>
#include <type_traits>
#include <vector>
#include <stdexcept>
#include <licensecc/datatypes.h>

#include "../base/base64.h"
#include "../base/EventRegistry.h"
#include "../base/string_utils.h"

#include "ExternalDefinition.hpp"
#include "../base/file_utils.hpp"

namespace license {
namespace locate {
using namespace std;

namespace {

using LicenseDataTypeStorage = std::underlying_type<LCC_LICENSE_DATA_TYPE>::type;

LicenseDataTypeStorage license_data_type_storage(const LicenseLocation& location) {
	LicenseDataTypeStorage value = 0;
	static_assert(sizeof(value) == sizeof(location.license_data_type),
				  "LCC_LICENSE_DATA_TYPE storage size must match its underlying type");
	memcpy(&value, &location.license_data_type, sizeof(value));
	return value;
}

bool external_payload_type_requires_clear_tail(const LicenseDataTypeStorage type) {
	return type == static_cast<LicenseDataTypeStorage>(LICENSE_ENCODED) ||
		   type == static_cast<LicenseDataTypeStorage>(LICENSE_PLAIN_DATA);
}

bool external_payload_has_hidden_bytes(const char* data, const size_t visible_size) {
	if (visible_size >= LCC_API_MAX_LICENSE_DATA_LENGTH) {
		return false;
	}
	for (size_t i = visible_size + 1; i < LCC_API_MAX_LICENSE_DATA_LENGTH; ++i) {
		if (data[i] != '\0') {
			return true;
		}
	}
	return false;
}

}  // namespace

ExternalDefinition::ExternalDefinition(const LicenseLocation *location)
	: LocatorStrategy("ExternalDefinition"), m_location(location) {}

ExternalDefinition::~ExternalDefinition() {}

const std::vector<std::string> ExternalDefinition::license_locations(EventRegistry &eventRegistry) {
	vector<string> existing_pos;
	if (m_location->licenseData[0] != '\0') {
		eventRegistry.addEvent(LICENSE_SPECIFIED, get_strategy_name());
		const size_t lic_data_size = mstrnlen_s(m_location->licenseData, LCC_API_MAX_LICENSE_DATA_LENGTH);
		if (lic_data_size == LCC_API_MAX_LICENSE_DATA_LENGTH) {
			eventRegistry.addEvent(LICENSE_MALFORMED, get_strategy_name().c_str(),
								   "license data is not NUL-terminated");
			return existing_pos;
		}
		const LicenseDataTypeStorage license_data_type = license_data_type_storage(*m_location);
		if (external_payload_type_requires_clear_tail(license_data_type) &&
			external_payload_has_hidden_bytes(m_location->licenseData, lic_data_size)) {
			eventRegistry.addEvent(LICENSE_MALFORMED, get_strategy_name().c_str(),
								   "license data contains embedded NUL bytes");
			return existing_pos;
		}
		switch (license_data_type) {
			case static_cast<LicenseDataTypeStorage>(LICENSE_PATH): {
				string licData(m_location->licenseData, lic_data_size);
				const vector<string> declared_positions = license::split_string(licData, ';');
				existing_pos =
					license::filter_existing_files(declared_positions, eventRegistry, get_strategy_name().c_str(),
												   LCC_API_MAX_LICENSE_DATA_LENGTH);
			} break;
			case static_cast<LicenseDataTypeStorage>(LICENSE_ENCODED): {
				string licData(m_location->licenseData, lic_data_size);
				vector<uint8_t> raw = unbase64(licData);
				if (raw.empty()) {
					eventRegistry.addEvent(LICENSE_MALFORMED, get_strategy_name().c_str(), "invalid encoded license data");
				} else {
					const string decoded(reinterpret_cast<const char *>(raw.data()), raw.size());
					if (identify_format(decoded) != INI) {
						eventRegistry.addEvent(LICENSE_MALFORMED, get_strategy_name().c_str(),
											   "encoded license data is not an INI license");
					} else {
						existing_pos.push_back(get_strategy_name());
					}
				}
			} break;
			case static_cast<LicenseDataTypeStorage>(LICENSE_PLAIN_DATA): {
				string licData(m_location->licenseData, lic_data_size);
				if (identify_format(licData) != INI) {
					eventRegistry.addEvent(LICENSE_MALFORMED, get_strategy_name().c_str(),
										   "plain license data is not an INI license");
				} else {
					existing_pos.push_back(get_strategy_name());
				}
			} break;
			default:
				eventRegistry.addEvent(LICENSE_MALFORMED, get_strategy_name().c_str(), "license type not supported");
				break;
		}
	}
	return existing_pos;
}

const std::string ExternalDefinition::retrieve_license_content(const std::string &licenseLocation) const {
	if (licenseLocation == get_strategy_name()) {
		const size_t lic_data_size = mstrnlen_s(m_location->licenseData, LCC_API_MAX_LICENSE_DATA_LENGTH);
		if (lic_data_size == LCC_API_MAX_LICENSE_DATA_LENGTH) {
			return string();
		}
		string licData(m_location->licenseData, lic_data_size);
		if (license_data_type_storage(*m_location) == static_cast<LicenseDataTypeStorage>(LICENSE_ENCODED)) {
			vector<uint8_t> raw = unbase64(licData);
			string str;
			if (!raw.empty()) {
				str.assign(reinterpret_cast<const char *>(raw.data()), raw.size());
			}
			return str;
		} else {
			return licData;
		}
	} else {
		return LocatorStrategy::retrieve_license_content(licenseLocation);
	}
}

} /* namespace locate */
} /* namespace license */
