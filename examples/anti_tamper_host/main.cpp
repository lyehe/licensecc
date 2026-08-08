// Best-effort host-integrity example.
//
// IMPORTANT: this is NOT tamper-proof. A host_integrity_check is a best-effort signal on a machine the
// attacker may fully control; it can be patched out or hooked. Treat it as one input to a layered defense
// (server-side entitlement checks, online verification, telemetry), never as a guarantee.
#include <cstdio>
#include <cstring>

#include <licensecc/licensecc.h>

#ifdef _WIN32
#include <windows.h>
#endif

namespace {

void write_detail(char* detail_out, size_t detail_out_size, const char* detail) {
	if (detail_out == nullptr || detail_out_size == 0) {
		return;
	}
	std::snprintf(detail_out, detail_out_size, "%s", detail);
}

// Compose product-specific best-effort checks here. Examples include a debugger probe,
// signed self-measurement, and parent-process policy. Keep details short and non-sensitive.
bool host_integrity_check(void* user_data, char* detail_out, size_t detail_out_size) {
	(void)user_data;
#ifdef _WIN32
	if (IsDebuggerPresent()) {
		write_detail(detail_out, detail_out_size, "debugger present");
		return false;
	}
#endif
	return true;
}

}  // namespace

int main(int argc, char** argv) {
	if (argc < 2) {
		std::fprintf(stderr, "usage: %s <license-path>\n", argv[0]);
		return 2;
	}
	lcc_set_environment_license_sources_enabled(false);

	LicenseLocation location;
	if (!lcc_set_license_path(&location, argv[1])) {
		std::fprintf(stderr, "license path is too long\n");
		return 2;
	}
	CallerInformations caller;
	lcc_init_caller_informations(&caller);

	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);  // tamper_policy defaults to LCC_TAMPER_ENFORCE
	options.host_integrity_check = host_integrity_check;

	LicenseInfo info{};
	const LCC_EVENT_TYPE result = acquire_license_ex(&caller, &location, &info, &options);
	if (result == LICENSE_OK) {
		std::printf("license OK (runtime integrity check passed)\n");
		return 0;
	}
	char message[LCC_API_ERROR_BUFFER_SIZE];
	print_error(message, &info);
	std::fprintf(stderr, "denied: %s\n  detail: %s\n", lcc_strerror(result), message);
	return 1;
}
