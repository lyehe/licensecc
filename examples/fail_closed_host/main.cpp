// Fail-closed host application example.
//
// Protected features start disabled. The application enables each capability
// only after acquire_license() returns LICENSE_OK for that specific product or
// feature check.
#include <cstdio>
#include <cstring>

#include <licensecc/licensecc.h>

namespace {

struct ProtectedFeatures {
	bool application = false;
	bool reports = false;
	bool export_data = false;
};

void print_diagnostic(const char* label, LCC_EVENT_TYPE result, const LicenseInfo& info) {
	char message[LCC_API_ERROR_BUFFER_SIZE];
	print_error(message, &info);
	std::fprintf(stderr, "%s unavailable: %s\n  detail: %s\n", label, lcc_strerror(result), message);
}

bool check_entitlement(const LicenseLocation* location, const char* feature, const char* version, const char* label,
					   LicenseInfo* info) {
	CallerInformations caller;
	lcc_init_caller_informations(&caller);
	if (feature != nullptr && feature[0] != '\0' && !lcc_set_caller_feature_name(&caller, feature)) {
		std::fprintf(stderr, "feature name is too long\n");
		return false;
	}
	if (version != nullptr && version[0] != '\0' && !lcc_set_caller_version(&caller, version)) {
		std::fprintf(stderr, "caller version is too long\n");
		return false;
	}

	lcc_init_license_info(info);
	const LCC_EVENT_TYPE result = acquire_license(&caller, location, info);
	if (result == LICENSE_OK) {
		return true;
	}

	print_diagnostic(label, result, *info);
	return false;
}

void print_feature_state(const char* name, bool enabled) {
	std::printf("%s %s\n", name, enabled ? "enabled" : "unavailable");
}

void maybe_print_support_identifier(bool requested) {
	if (!requested) {
		return;
	}
	char identifier[LCC_API_PC_IDENTIFIER_SIZE + 1];
	size_t identifier_size = sizeof(identifier);
	if (identify_pc(STRATEGY_DEFAULT, identifier, &identifier_size, nullptr)) {
		std::printf("support hardware identifier: %s\n", identifier);
		return;
	}
	std::printf("support hardware identifier unavailable\n");
}

}  // namespace

int main(int argc, char** argv) {
	if (argc < 3) {
		std::fprintf(stderr, "usage: %s <license-path> <app-version> [--print-id]\n", argv[0]);
		return 2;
	}

	lcc_set_environment_license_sources_enabled(false);
	lcc_set_strict_source_fatal_enabled(true);

	const bool print_support_id = argc > 3 && std::strcmp(argv[3], "--print-id") == 0;

	LicenseLocation location;
	if (!lcc_set_license_path(&location, argv[1])) {
		std::fprintf(stderr, "license path is too long\n");
		return 2;
	}

	const char* version = argv[2];
	ProtectedFeatures features;

	LicenseInfo product_info = {};
	if (!check_entitlement(&location, "", version, "application", &product_info)) {
		print_feature_state("application", features.application);
		print_feature_state("REPORTS", features.reports);
		print_feature_state("EXPORT", features.export_data);
		maybe_print_support_identifier(print_support_id);
		return 1;
	}

	features.application = true;
	print_feature_state("application", features.application);
	if (product_info.proprietary_data[0] != '\0') {
		std::printf("signed data: %s\n", product_info.proprietary_data);
	}

	LicenseInfo reports_info = {};
	features.reports = check_entitlement(&location, "REPORTS", version, "REPORTS", &reports_info);
	print_feature_state("REPORTS", features.reports);

	LicenseInfo export_info = {};
	features.export_data = check_entitlement(&location, "EXPORT", version, "EXPORT", &export_info);
	print_feature_state("EXPORT", features.export_data);

	maybe_print_support_identifier(print_support_id);
	return 0;
}
