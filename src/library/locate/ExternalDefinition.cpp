/*
 * ExplicitDefinition.cpp
 *
 *  Created on: Oct 12, 2019
 *      Author: Gabriele Contini
 */

#include <stdlib.h>
#include <cstring>
#include <string>
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
		switch (m_location->license_data_type) {
			case LICENSE_PATH: {
				string licData(m_location->licenseData, lic_data_size);
				const vector<string> declared_positions = license::split_string(licData, ';');
				existing_pos =
					license::filter_existing_files(declared_positions, eventRegistry, get_strategy_name().c_str(),
												   LCC_API_MAX_LICENSE_DATA_LENGTH);
			} break;
			case LICENSE_ENCODED: {
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
			case LICENSE_PLAIN_DATA: {
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
		if (m_location->license_data_type == LICENSE_ENCODED) {
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
