#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include <licensecc/licensecc.h>
#include <licensecc_properties.h>

#include "../../src/library/LicenseReader.hpp"
#include "../../src/library/locate/LocatorFactory.hpp"
#include "../../src/library/os/os.h"

namespace {

void populate_location(LicenseLocation &location, const uint8_t *data, size_t size, LCC_LICENSE_DATA_TYPE data_type) {
	location.license_data_type = data_type;
	const size_t max_copy_size = static_cast<size_t>(LCC_API_MAX_LICENSE_DATA_LENGTH - 1);
	const size_t copy_size = size < max_copy_size ? size : max_copy_size;
	std::memcpy(location.licenseData, data, copy_size);
	location.licenseData[copy_size] = '\0';
}

void populate_caller(CallerInformations &caller, const char *product, unsigned int magic) {
	caller = CallerInformations{};
	caller.magic = magic;
	if (product == nullptr || product[0] == '\0') {
		return;
	}
	const size_t feature_size = std::strlen(product);
	if (feature_size < sizeof(caller.feature_name)) {
		std::memcpy(caller.feature_name, product, feature_size);
		caller.feature_name[feature_size] = '\0';
	}
}

bool has_plain_license_shape(const std::string &input) {
	return input.find('[') != std::string::npos && input.find(']') != std::string::npos &&
		   input.find("lic_ver = ") != std::string::npos && input.find("sig = ") != std::string::npos;
}

void fuzz_reader(const uint8_t *data, size_t size, LCC_LICENSE_DATA_TYPE data_type, const char *product) {
	LicenseLocation location = {};
	populate_location(location, data, size, data_type);

	std::vector<license::FullLicenseInfo> licenses;
	const license::LicenseReader reader(&location);
	(void)reader.readLicenses(product, licenses);
}

void fuzz_acquire(const uint8_t *data, size_t size, LCC_LICENSE_DATA_TYPE data_type, const char *product,
				  unsigned int magic) {
	LicenseLocation location = {};
	populate_location(location, data, size, data_type);
	CallerInformations caller = {};
	populate_caller(caller, product, magic);
	LicenseInfo info = {};

	const LCC_EVENT_TYPE result = acquire_license(&caller, &location, &info);
	char error_buffer[LCC_API_ERROR_BUFFER_SIZE] = {};
	print_error(error_buffer, &info);

	if (data_type == LICENSE_PLAIN_DATA && result == LICENSE_OK) {
		const std::string input(reinterpret_cast<const char *>(data), size);
		if (!has_plain_license_shape(input)) {
			std::abort();
		}
	}
}

void fuzz_environment(const uint8_t *data, size_t size, const char *product, unsigned int magic) {
	const std::string input(reinterpret_cast<const char *>(data), size);
	if (input.find('\0') != std::string::npos) {
		return;
	}
	CallerInformations caller = {};
	populate_caller(caller, product, magic);

	lcc_set_environment_license_sources_enabled(true);
	license::locate::LocatorFactory::find_license_near_module(false);
	license::locate::LocatorFactory::find_license_with_env_var(true);

	SETENV(LCC_LICENSE_DATA_ENV_VAR, input.c_str());
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	LicenseInfo data_info = {};
	(void)acquire_license(&caller, nullptr, &data_info);

	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
	SETENV(LCC_LICENSE_LOCATION_ENV_VAR, input.c_str());
	LicenseInfo location_info = {};
	(void)acquire_license(&caller, nullptr, &location_info);

	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	lcc_set_environment_license_sources_enabled(false);
	license::locate::LocatorFactory::find_license_with_env_var(false);
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
	if (size > static_cast<size_t>(LCC_API_MAX_LICENSE_DATA_LENGTH + 256)) {
		return 0;
	}
	lcc_set_environment_license_sources_enabled(false);
	lcc_set_strict_source_fatal_enabled(true);
	license::locate::LocatorFactory::find_license_near_module(false);
	license::locate::LocatorFactory::find_license_with_env_var(false);

	fuzz_reader(data, size, LICENSE_PLAIN_DATA, LCC_FUZZ_PROJECT_NAME);
	fuzz_reader(data, size, LICENSE_PLAIN_DATA, "FUZZ_FEATURE");
	fuzz_reader(data, size, LICENSE_PLAIN_DATA, "MY_PRODUCT");
	fuzz_reader(data, size, LICENSE_ENCODED, LCC_FUZZ_PROJECT_NAME);
	fuzz_reader(data, size, LICENSE_PATH, LCC_FUZZ_PROJECT_NAME);

	fuzz_acquire(data, size, LICENSE_PLAIN_DATA, LCC_FUZZ_PROJECT_NAME, LCC_PROJECT_MAGIC_NUM);
	fuzz_acquire(data, size, LICENSE_PLAIN_DATA, "MY_PRODUCT", LCC_PROJECT_MAGIC_NUM);
	fuzz_acquire(data, size, LICENSE_ENCODED, LCC_FUZZ_PROJECT_NAME, LCC_PROJECT_MAGIC_NUM);
	fuzz_acquire(data, size, LICENSE_PATH, LCC_FUZZ_PROJECT_NAME, LCC_PROJECT_MAGIC_NUM);

	const unsigned int bad_magic = LCC_PROJECT_MAGIC_NUM == 42U ? 43U : 42U;
	fuzz_acquire(data, size, LICENSE_PLAIN_DATA, LCC_FUZZ_PROJECT_NAME, bad_magic);
	fuzz_acquire(data, size, LICENSE_PATH, LCC_FUZZ_PROJECT_NAME, bad_magic);
	fuzz_environment(data, size, LCC_FUZZ_PROJECT_NAME, LCC_PROJECT_MAGIC_NUM);
	fuzz_environment(data, size, LCC_FUZZ_PROJECT_NAME, bad_magic);

	return 0;
}
