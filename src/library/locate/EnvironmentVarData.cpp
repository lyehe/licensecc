/*
 * EnvironmentVarData.cpp
 *
 *  Created on: Oct 12, 2019
 *     Author: Gabriele Contini
 */

#include "EnvironmentVarData.hpp"
#include <licensecc/datatypes.h>

#include <licensecc_properties.h>
#include <cstdlib>
#include <regex>
#include <string>
#include <vector>

#include "../base/base64.h"
#include "../base/EventRegistry.h"
#include "../base/string_utils.h"

namespace license {
namespace locate {

using namespace std;

EnvironmentVarData::EnvironmentVarData() : LocatorStrategy("EnvironmentVarData") {}

EnvironmentVarData::~EnvironmentVarData() {}

const vector<string> EnvironmentVarData::license_locations(EventRegistry &eventRegistry) {
	vector<string> diskFiles;
	char *env_var_value = getenv(LCC_LICENSE_DATA_ENV_VAR);
	if (env_var_value != nullptr && env_var_value[0] != '\0') {
		eventRegistry.addEvent(LICENSE_SPECIFIED, LCC_LICENSE_DATA_ENV_VAR);
		if (mstrnlen_s(env_var_value, LCC_API_MAX_LICENSE_DATA_LENGTH + 1) > LCC_API_MAX_LICENSE_DATA_LENGTH) {
			eventRegistry.addEvent(LICENSE_MALFORMED, LCC_LICENSE_DATA_ENV_VAR, "license data exceeds maximum size");
			return diskFiles;
		}
		FILE_FORMAT licenseFormat = identify_format(env_var_value);
		if (licenseFormat == UNKNOWN) {
			eventRegistry.addEvent(LICENSE_MALFORMED, LCC_LICENSE_DATA_ENV_VAR);
		} else {
			isBase64 = (licenseFormat == BASE64);
			if (isBase64) {
				vector<uint8_t> data = unbase64(env_var_value);
				if (data.empty()) {
					eventRegistry.addEvent(LICENSE_MALFORMED, LCC_LICENSE_DATA_ENV_VAR);
					return diskFiles;
				}
				if (data.size() > LCC_API_MAX_LICENSE_DATA_LENGTH) {
					eventRegistry.addEvent(LICENSE_MALFORMED, LCC_LICENSE_DATA_ENV_VAR,
										   "decoded license data exceeds maximum size");
					return diskFiles;
				}
				const string decoded(reinterpret_cast<const char *>(data.data()), data.size());
				if (identify_format(decoded) != INI) {
					eventRegistry.addEvent(LICENSE_MALFORMED, LCC_LICENSE_DATA_ENV_VAR);
					return diskFiles;
				}
			}
			diskFiles.push_back(LCC_LICENSE_DATA_ENV_VAR);
		}
	} else {
		eventRegistry.addEvent(ENVIRONMENT_VARIABLE_NOT_DEFINED, LCC_LICENSE_DATA_ENV_VAR);
	}
	return diskFiles;
}

const std::string EnvironmentVarData::retrieve_license_content(const std::string &licenseLocation) const {
	const char *env_val = getenv(LCC_LICENSE_DATA_ENV_VAR);
	if (env_val == nullptr) {
		return "";
	}
	if (mstrnlen_s(env_val, LCC_API_MAX_LICENSE_DATA_LENGTH + 1) > LCC_API_MAX_LICENSE_DATA_LENGTH) {
		return "";
	}
	if (isBase64) {
		vector<uint8_t> data = unbase64(env_val);
		string str;
		if (!data.empty() && data.size() <= LCC_API_MAX_LICENSE_DATA_LENGTH) {
			str.assign(reinterpret_cast<const char *>(data.data()), data.size());
		}
		return str;
	}
	return string(env_val);
}

}  // namespace locate
}  // namespace license
