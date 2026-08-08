/*
 * ApplicationFolder.cpp
 *
 *  Created on: Oct 12, 2019
 *      Author: Gabriele Contini
 */
#include <fstream>
#include <sstream>
#include <string>
#include <cstdint>
#include <iostream>

#include <licensecc/datatypes.h>
#include <licensecc_properties.h>

#include "../base/logger.h"
#include "../base/base.h"
#include "../base/EventRegistry.h"
#include "../os/os.h"
#include "ApplicationFolder.hpp"
#include "../base/file_utils.hpp"

namespace license {
namespace locate {
using namespace std;

ApplicationFolder::ApplicationFolder() : LocatorStrategy("ApplicationFolder") {}

ApplicationFolder::~ApplicationFolder() {}

const vector<string> ApplicationFolder::license_locations(EventRegistry &eventRegistry) {
	vector<string> diskFiles;
	char fname[MAX_PATH] = {0};
	const FUNCTION_RETURN fret = getModuleName(fname);
	if (fret == FUNC_RET_OK) {
		const string module_name = remove_extension(fname);
		const string temptativeLicense = string(module_name) + LCC_LICENSE_FILE_EXTENSION;
		ifstream f(temptativeLicense.c_str(), ios::binary | ios::ate);
		if (f.good()) {
			const streampos file_size = f.tellg();
			if (file_size >= 0 && static_cast<uintmax_t>(file_size) > LCC_API_MAX_LICENSE_DATA_LENGTH) {
				eventRegistry.addEvent(LICENSE_MALFORMED, temptativeLicense.c_str(), "license file exceeds maximum size");
			} else {
				diskFiles.push_back(temptativeLicense);
				eventRegistry.addEvent(LICENSE_FOUND, temptativeLicense.c_str());
			}
		} else {
			eventRegistry.addEvent(LICENSE_FILE_NOT_FOUND, temptativeLicense.c_str());
		}
		f.close();
	} else {
		LOG_WARN("Error determining module name.");
	}
	return diskFiles;
}

}  // namespace locate
} /* namespace license */
