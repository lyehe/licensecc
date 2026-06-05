#include <cstddef>
#include <cstdint>
#include <exception>
#include <string>

#include "../../extern/license-generator/src/base_lib/base.h"
#include "../../extern/license-generator/src/license_generator/license.hpp"
#include "../../src/library/hw_identifier/hw_identifier.hpp"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
	if (size > 4096) {
		return 0;
	}
	const std::string input(reinterpret_cast<const char *>(data), size);

	try {
		const license::hw_identifier::HwIdentifier identifier(input);
		(void)identifier.print();
		(void)identifier.get_identification_strategy();
	} catch (const std::exception &) {
	}

	try {
		license::License generator_license(nullptr, LCC_FUZZ_PROJECT_DIR);
		generator_license.add_parameter(PARAM_CLIENT_SIGNATURE, input);
	} catch (const std::exception &) {
	}

	try {
		license::License permissive_generator_license(nullptr, LCC_FUZZ_PROJECT_DIR);
		permissive_generator_license.set_allow_ip_binding(true);
		permissive_generator_license.set_allow_env_selected_binding(true);
		permissive_generator_license.add_parameter(PARAM_CLIENT_SIGNATURE, input);
	} catch (const std::exception &) {
	}

	return 0;
}
