// Licensecc workflow example.
//
// Demonstrates a production-style host workflow:
//   - configure runtime policy before checking licenses;
//   - use bounded public API setters;
//   - check the base product and optional features separately;
//   - read signed extra-data only after LICENSE_OK;
//   - print diagnostics without granting access;
//   - print a hardware identifier only on explicit support request.
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include <licensecc/licensecc.h>

namespace {

struct Options {
	std::string license_path;
	std::string plain_license_data;
	std::string encoded_license_data;
	std::string version;
	std::vector<std::string> features;
	bool print_identifier = false;
	bool allow_environment_sources = false;
	bool lenient_sources = false;
};

void print_usage(const char* exe) {
	std::fprintf(stderr,
				 "usage: %s [--license PATH | --plain-license-data TEXT | --encoded-license-data TEXT]\n"
				 "          [--version VERSION] [--feature NAME ...] [--print-id]\n"
				 "          [--allow-env] [--lenient-sources]\n\n"
				 "examples:\n"
				 "  %s --license customer.lic --version 1.2.3\n"
				 "  %s --license customer.lic --version 1.2.3 --feature REPORTS --feature EXPORT\n"
				 "  %s --print-id\n",
				 exe, exe, exe, exe);
}

bool require_value(int argc, char** argv, int& index, const char* option, std::string& out) {
	if (index + 1 >= argc) {
		std::fprintf(stderr, "%s requires a value\n", option);
		return false;
	}
	out = argv[++index];
	return true;
}

bool parse_options(int argc, char** argv, Options& options) {
	for (int i = 1; i < argc; ++i) {
		const std::string arg(argv[i]);
		if (arg == "--help" || arg == "-h") {
			print_usage(argv[0]);
			return false;
		}
		if (arg == "--license") {
			if (!require_value(argc, argv, i, "--license", options.license_path)) {
				return false;
			}
		} else if (arg == "--plain-license-data") {
			if (!require_value(argc, argv, i, "--plain-license-data", options.plain_license_data)) {
				return false;
			}
		} else if (arg == "--encoded-license-data") {
			if (!require_value(argc, argv, i, "--encoded-license-data", options.encoded_license_data)) {
				return false;
			}
		} else if (arg == "--version") {
			if (!require_value(argc, argv, i, "--version", options.version)) {
				return false;
			}
		} else if (arg == "--feature") {
			std::string feature;
			if (!require_value(argc, argv, i, "--feature", feature)) {
				return false;
			}
			options.features.push_back(feature);
		} else if (arg == "--print-id") {
			options.print_identifier = true;
		} else if (arg == "--allow-env") {
			options.allow_environment_sources = true;
		} else if (arg == "--lenient-sources") {
			options.lenient_sources = true;
		} else {
			std::fprintf(stderr, "unknown option: %s\n", arg.c_str());
			print_usage(argv[0]);
			return false;
		}
	}

	int source_count = 0;
	source_count += options.license_path.empty() ? 0 : 1;
	source_count += options.plain_license_data.empty() ? 0 : 1;
	source_count += options.encoded_license_data.empty() ? 0 : 1;
	if (source_count > 1) {
		std::fprintf(stderr, "choose only one license source option\n");
		return false;
	}
	return true;
}

const char* yes_no(bool value) {
	return value ? "yes" : "no";
}

void print_failure_detail(const char* label, LCC_EVENT_TYPE result, const LicenseInfo& info) {
	char message[LCC_API_ERROR_BUFFER_SIZE];
	print_error(message, &info);
	std::fprintf(stderr, "%s denied: %s\n  detail: %s\n", label, lcc_strerror(result), message);
}

bool configure_location(const Options& options, LicenseLocation& location, const LicenseLocation*& location_ptr) {
	location_ptr = nullptr;
	if (!options.license_path.empty()) {
		if (!lcc_set_license_path(&location, options.license_path.c_str())) {
			std::fprintf(stderr, "license path is too long\n");
			return false;
		}
		location_ptr = &location;
		return true;
	}
	if (!options.plain_license_data.empty()) {
		if (!lcc_set_license_location_data(&location, LICENSE_PLAIN_DATA, options.plain_license_data.c_str())) {
			std::fprintf(stderr, "plain license data is too long\n");
			return false;
		}
		location_ptr = &location;
		return true;
	}
	if (!options.encoded_license_data.empty()) {
		if (!lcc_set_license_location_data(&location, LICENSE_ENCODED, options.encoded_license_data.c_str())) {
			std::fprintf(stderr, "encoded license data is too long\n");
			return false;
		}
		location_ptr = &location;
		return true;
	}
	return true;
}

bool check_entitlement(const LicenseLocation* location, const std::string& feature, const std::string& version,
					   const char* label) {
	CallerInformations caller;
	lcc_init_caller_informations(&caller);
	if (!feature.empty() && !lcc_set_caller_feature_name(&caller, feature.c_str())) {
		std::fprintf(stderr, "%s feature name is too long\n", label);
		return false;
	}
	if (!version.empty() && !lcc_set_caller_version(&caller, version.c_str())) {
		std::fprintf(stderr, "caller version is too long\n");
		return false;
	}

	LicenseInfo info;
	lcc_init_license_info(&info);
	const LCC_EVENT_TYPE result = acquire_license(&caller, location, &info);
	if (result != LICENSE_OK) {
		print_failure_detail(label, result, info);
		return false;
	}

	std::printf("%s granted\n", label);
	std::printf("  license version: %d\n", info.license_version);
	std::printf("  expires: %s\n", info.has_expiry ? info.expiry_date : "no");
	std::printf("  days left: %u\n", info.days_left);
	std::printf("  hardware-bound: %s\n", yes_no(info.linked_to_pc));
	if (info.proprietary_data[0] != '\0') {
		std::printf("  signed extra-data: %s\n", info.proprietary_data);
	}
	return true;
}

void print_support_identifier() {
	std::vector<char> identifier(LCC_API_PC_IDENTIFIER_SIZE + 1, '\0');
	size_t size = identifier.size();
	ExecutionEnvironmentInfo environment_info;
	if (identify_pc(STRATEGY_DEFAULT, identifier.data(), &size, &environment_info)) {
		std::printf("support hardware identifier: %s\n", identifier.data());
		std::printf("  virtualization summary: %d\n", static_cast<int>(environment_info.virtualization));
		std::printf("  cloud provider: %d\n", static_cast<int>(environment_info.cloud_provider));
		return;
	}
	std::printf("hardware identifier unavailable\n");
	std::printf("  required buffer size: %u\n", static_cast<unsigned int>(size));
	std::printf("  virtualization summary: %d\n", static_cast<int>(environment_info.virtualization));
	std::printf("  cloud provider: %d\n", static_cast<int>(environment_info.cloud_provider));
}

}  // namespace

int main(int argc, char** argv) {
	Options options;
	if (!parse_options(argc, argv, options)) {
		return 2;
	}

	lcc_set_environment_license_sources_enabled(options.allow_environment_sources);
	lcc_set_strict_source_fatal_enabled(!options.lenient_sources);

	LicenseLocation location;
	LicenseLocation const* location_ptr = NULL;
	if (!configure_location(options, location, location_ptr)) {
		return 2;
	}
	const bool only_print_identifier = options.print_identifier && location_ptr == NULL &&
									   !options.allow_environment_sources && options.version.empty() &&
									   options.features.empty();

	std::printf("Licensecc workflow demo\n");
	std::printf("  environment license sources: %s\n", yes_no(options.allow_environment_sources));
	std::printf("  strict source handling: %s\n", yes_no(!options.lenient_sources));
	std::printf("  caller version: %s\n", options.version.empty() ? "(not set)" : options.version.c_str());

	if (only_print_identifier) {
		print_support_identifier();
		return 0;
	}

	bool ok = check_entitlement(location_ptr, "", options.version, "base product");
	for (size_t i = 0; i < options.features.size(); ++i) {
		ok = check_entitlement(location_ptr, options.features[i], options.version, options.features[i].c_str()) && ok;
	}

	if (options.print_identifier) {
		print_support_identifier();
	}

	return ok ? 0 : 1;
}
