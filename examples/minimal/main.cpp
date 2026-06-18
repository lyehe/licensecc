// Minimal licensecc integration example.
//
// Shows the whole consumer API surface you usually need:
//   - acquire_license_ex() to check the license with enforced tamper policy defaults
//   - lcc_strerror()       to turn the result code into a message
//   - print_error()        to summarise why a check failed
//
// This example is standalone: it is NOT built by the main licensecc build.
// See README.md in this folder for how to build it against an installed
// licensecc.
#include <cstdio>
#include <cstdlib>

#include <licensecc/licensecc.h>

int main(int argc, char **argv) {
	// Either pass an explicit license file path, or pass NULL as the location to
	// let licensecc search its default locations (next to the executable / an
	// environment variable, depending on how it was configured).
	LicenseLocation location;
	lcc_init_license_location(&location, LICENSE_PATH);
	const LicenseLocation *location_ptr = nullptr;
	if (argc > 1) {
		if (!lcc_set_license_path(&location, argv[1])) {
			std::fprintf(stderr, "license path is too long\n");
			return 2;
		}
		location_ptr = &location;
	}

	CallerInformations caller;
	lcc_init_caller_informations(&caller);
	const CallerInformations *caller_ptr = &caller;
	if (argc > 2) {
		if (!lcc_set_caller_feature_name(&caller, argv[2])) {
			std::fprintf(stderr, "feature name is too long\n");
			return 2;
		}
	}
	if (argc > 3) {
		if (!lcc_set_caller_version(&caller, argv[3])) {
			std::fprintf(stderr, "caller version is too long\n");
			return 2;
		}
	}
	if (argc > 4) {
		char *end = nullptr;
		const unsigned long magic = strtoul(argv[4], &end, 10);
		if (end == argv[4] || *end != '\0') {
			fprintf(stderr, "invalid magic value\n");
			return 2;
		}
		caller.magic = static_cast<unsigned int>(magic);
	}

	LicenseInfo info;
	lcc_init_license_info(&info);
	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);
	const LCC_EVENT_TYPE result = acquire_license_ex(caller_ptr, location_ptr, &info, &options);
	if (result == LICENSE_OK) {
		if (caller_ptr != nullptr && caller.feature_name[0] != '\0') {
			printf("license OK for feature %s (days left: %u)\n", caller.feature_name, info.days_left);
		} else {
			printf("license OK (days left: %u)\n", info.days_left);
		}
		return 0;
	}

	char message[LCC_API_ERROR_BUFFER_SIZE];
	print_error(message, &info);
	fprintf(stderr, "license check failed: %s\n  detail: %s\n", lcc_strerror(result), message);
	return 1;
}
