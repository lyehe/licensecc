// Minimal licensecc integration example.
//
// Shows the whole consumer API surface you usually need:
//   - acquire_license()  to check the license
//   - lcc_strerror()      to turn the result code into a message
//   - print_error()       to summarise why a check failed
//
// This example is standalone: it is NOT built by the main licensecc build.
// See README.md in this folder for how to build it against an installed
// licensecc.
#include <cstdio>
#include <cstring>

#include <licensecc/licensecc.h>

int main(int argc, char **argv) {
	// Either pass an explicit license file path, or pass NULL as the location to
	// let licensecc search its default locations (next to the executable / an
	// environment variable, depending on how it was configured).
	LicenseLocation location = {LICENSE_PATH};
	const LicenseLocation *location_ptr = nullptr;
	if (argc > 1) {
		strncpy(location.licenseData, argv[1], sizeof(location.licenseData) - 1);
		location_ptr = &location;
	}

	LicenseInfo info;
	const LCC_EVENT_TYPE result = acquire_license(nullptr, location_ptr, &info);
	if (result == LICENSE_OK) {
		printf("license OK (days left: %u)\n", info.days_left);
		return 0;
	}

	char message[LCC_API_ERROR_BUFFER_SIZE];
	print_error(message, &info);
	fprintf(stderr, "license check failed: %s\n  detail: %s\n", lcc_strerror(result), message);
	return 1;
}
