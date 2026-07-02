#include <iostream>
#include <vector>
#include <map>
#include <unordered_map>
#include <licensecc/licensecc.h>
#include <fstream>
#include <string.h>
#include <iomanip>
#include <sstream>
#include <ctime>
#include <random>
#include "../library/base/string_utils.h"
#include "../library/ini/SimpleIni.h"
#include "../library/os/dmi_info.hpp"
#include "../library/os/cpu_info.hpp"
#include "../library/os/dmi_info.hpp"
#include "../library/os/network.hpp"
#include "../library/activation/ActivationRequest.hpp"
#include "inspector_section.hpp"

using namespace std;
using namespace license::os;

const map<int, string> stringByStrategyId = {
	{STRATEGY_DEFAULT, "DEFAULT"}, {STRATEGY_ETHERNET, "MAC"}, {STRATEGY_IP_ADDRESS, "IP"}, {STRATEGY_DISK, "Disk"}};

const unordered_map<int, string> descByVirtDetail = {{BARE_TO_METAL, "No virtualization"},
													 {VMWARE, "Vmware"},
													 {VIRTUALBOX, "Virtualbox"},
													 {V_XEN, "XEN"},
													 {KVM, "KVM"},
													 {HV, "Microsoft Hypervisor"},
													 {PARALLELS, "Parallels Desktop"},
													 {V_OTHER, "Other type of vm"}};

const unordered_map<int, string> descByVirt = {{LCC_API_VIRTUALIZATION_SUMMARY::NONE, "No virtualization"},
											   {LCC_API_VIRTUALIZATION_SUMMARY::VM, "Virtual machine"},
											   {LCC_API_VIRTUALIZATION_SUMMARY::CONTAINER, "Container"}};

const unordered_map<int, string> descByCloudProvider = {{PROV_UNKNOWN, "Provider unknown"},
														{ON_PREMISE, "On premise hardware (no cloud)"},
														{GOOGLE_CLOUD, "Google Cloud"},
														{AZURE_CLOUD, "Microsoft Azure"},
														{AWS, "Amazon AWS"},
														{ALI_CLOUD, "Alibaba Cloud (Chinese cloud provider)"}};

static const char* kRedactedHardwareValue = "<redacted>";

// Safe description lookup: a value the OS layer returns that is not in the table (an unexpected
// virtualization/cloud enum) must NOT dereference map::end() (undefined behavior / crash). Return a
// readable fallback instead (audit R6.6).
template <typename Map, typename Key>
static string describe(const Map& table, Key key) {
	const auto it = table.find(key);
	return it != table.end() ? it->second : ("Unknown (" + to_string(static_cast<long long>(key)) + ")");
}

static string hardware_value_for_output(const string& value, const bool raw_hardware_output) {
	return raw_hardware_output ? value : kRedactedHardwareValue;
}

static string hardware_value_for_output(const int value, const bool raw_hardware_output) {
	return hardware_value_for_output(to_string(value), raw_hardware_output);
}

static string format_ipv4_address(const unsigned char ipv4_address[4]) {
	ostringstream out;
	out << static_cast<unsigned int>(ipv4_address[3]) << "-"
		<< static_cast<unsigned int>(ipv4_address[2]) << "-"
		<< static_cast<unsigned int>(ipv4_address[1]) << "-"
		<< static_cast<unsigned int>(ipv4_address[0]);
	return out.str();
}

static string format_mac_address(const unsigned char mac_address[6]) {
	ostringstream out;
	out << std::hex;
	for (int i = 0; i < 6; i++) {
		if (i != 0) {
			out << ":";
		}
		out << static_cast<unsigned int>(mac_address[i]);
	}
	return out.str();
}

static int run_redaction_self_test() {
	const string raw_value("AA-BB-CC-DD");
	if (hardware_value_for_output(raw_value, false) != kRedactedHardwareValue) {
		return 2;
	}
	if (hardware_value_for_output(raw_value, true) != raw_value) {
		return 3;
	}
	const unsigned char ip[4] = {1, 2, 3, 4};
	if (format_ipv4_address(ip) != "4-3-2-1") {
		return 4;
	}
	const unsigned char mac[6] = {0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff};
	if (format_mac_address(mac) != "aa:bb:cc:dd:ee:ff") {
		return 5;
	}
	// describe() returns the mapped value for a known key and a safe fallback for an unknown key
	// (never dereferences map::end()).
	const unordered_map<int, string> table = {{0, "zero"}};
	if (describe(table, 0) != "zero") {
		return 6;
	}
	if (describe(table, 999).rfind("Unknown", 0) != 0) {
		return 7;
	}
	return 0;
}

static void print_usage(const char* program_name) {
	cout << "Usage: " << program_name << " [--raw-hardware-identifiers] [license-file]" << endl;
	cout << "       " << program_name << " --activation-request [--feature <name>]" << endl;
	cout << "       " << program_name << " --decode-activation-request <lccareq1-string>" << endl;
	cout << "Hardware identifiers, IP addresses, and MAC addresses are redacted by default." << endl;
	cout << "Use --raw-hardware-identifiers only for trusted diagnostic handoff." << endl;
	cout << "--activation-request prints a copy-pasteable offline-activation request for an" << endl;
	cout << "air-gapped machine; an operator decodes it (--decode-activation-request) and issues a" << endl;
	cout << "hardware-bound license in response." << endl;
}

// Air-gapped machine side: print a canonical, copy-pasteable activation-request string for this
// machine's DEFAULT hardware identifier. The request is unsigned -- its integrity comes from the
// hardware-bound .lic the operator issues in response (which the normal verifier validates).
static int emit_activation_request(const string& feature) {
	char hw_identifier[LCC_API_PC_IDENTIFIER_SIZE + 1];
	size_t bufSize = sizeof(hw_identifier);
	memset(hw_identifier, 0, sizeof(hw_identifier));
	ExecutionEnvironmentInfo exec_env_info;
	if (!identify_pc(STRATEGY_DEFAULT, hw_identifier, &bufSize, &exec_env_info)) {
		cerr << "Unable to compute the hardware identifier for this machine." << endl;
		return 1;
	}
	license::activation::ActivationRequestFields fields;
	fields.project = LCC_PROJECT_NAME;
	fields.feature = feature;
	fields.hwid = hw_identifier;
	std::random_device rd;
	fields.nonce = (static_cast<uint64_t>(rd()) << 32) ^ static_cast<uint64_t>(rd());
	fields.issued_at = static_cast<uint64_t>(time(nullptr));
	const string request = license::activation::build_activation_request(fields);
	if (request.empty()) {
		cerr << "Unable to build the activation request (invalid field value)." << endl;
		return 1;
	}
	cout << request << endl;
	return 0;
}

// Operator side: decode an activation request and print the fields plus the ready-to-run license
// generator command that issues a hardware-bound license for the reported machine.
static int emit_decoded_activation_request(const string& token) {
	license::activation::ActivationRequestFields fields;
	string error;
	if (!license::activation::parse_activation_request(token, fields, error)) {
		cerr << error << endl;
		return 1;
	}
	cout << "project:   " << fields.project << endl;
	cout << "feature:   " << fields.feature << endl;
	cout << "hwid:      " << fields.hwid << endl;
	cout << "nonce:     " << fields.nonce << endl;
	cout << "issued-at: " << fields.issued_at << endl;
	cout << endl;
	cout << "Issue a hardware-bound license for this machine with:" << endl;
	cout << "  lccgen license issue --project-folder projects/" << fields.project
		 << " --client-signature " << fields.hwid << " --feature-names " << fields.feature
		 << " --license-version 201 --target-license-format-max 201"
		 << " --valid-to <YYYYMMDD> --output-file-name <out.lic>" << endl;
	return 0;
}

static LCC_EVENT_TYPE verifyLicense(const string& fname) {
	LicenseInfo licenseInfo;
	LicenseLocation licLocation = {LICENSE_PATH};
	if (!lcc_set_license_path(&licLocation, fname.c_str())) {
		cerr << "license path is too long: " << fname << endl;
		return LICENSE_FILE_NOT_FOUND;
	}
	LCC_EVENT_TYPE result = acquire_license(nullptr, &licLocation, &licenseInfo);
	if (result == LICENSE_OK) {
		cout << "default project [" << LCC_PROJECT_NAME << "]: license OK" << endl;
	} else {
		cerr << "default project [" << LCC_PROJECT_NAME << "]: " << lcc_strerror(result) << endl;
	}
	CSimpleIniA ini;
	ini.LoadFile(fname.c_str());
	CSimpleIniA::TNamesDepend sections;
	ini.GetAllSections(sections);
	CallerInformations callerInformation = {};
	for (CSimpleIniA::Entry section : sections) {
		const lccinspector::SectionAction action =
			lccinspector::classify_inspector_section(section.pItem, callerInformation);
		if (action == lccinspector::SectionAction::SkipDefaultProject) {
			continue;
		}
		if (action == lccinspector::SectionAction::NameTooLong) {
			cerr << "project [" << section.pItem << "]: feature name is too long" << endl;
			continue;
		}
		LCC_EVENT_TYPE feature_result = acquire_license(&callerInformation, &licLocation, &licenseInfo);
		if (feature_result == LICENSE_OK) {
			cout << "project [" << section.pItem << "]: license OK" << endl;
		} else {
			cerr << "project [" << section.pItem << "]: " << lcc_strerror(feature_result) << endl;
		}
	}
	return result;
}

int main(int argc, char* argv[]) {
	bool raw_hardware_output = false;
	bool activation_request_mode = false;
	string activation_feature = LCC_PROJECT_NAME;  // default feature == project name
	string license_path;
	for (int i = 1; i < argc; ++i) {
		const string arg(argv[i]);
		if (arg == "--help" || arg == "-h") {
			print_usage(argv[0]);
			return 0;
		}
		if (arg == "--raw-hardware-identifiers") {
			raw_hardware_output = true;
			continue;
		}
		if (arg == "--self-test-redaction") {
			return run_redaction_self_test();
		}
		if (arg == "--activation-request") {
			activation_request_mode = true;
			continue;
		}
		if (arg == "--feature") {
			if (i + 1 >= argc) {
				cerr << "--feature requires a value" << endl;
				return 1;
			}
			activation_feature = argv[++i];
			continue;
		}
		if (arg == "--decode-activation-request") {
			if (i + 1 >= argc) {
				cerr << "--decode-activation-request requires a value" << endl;
				return 1;
			}
			return emit_decoded_activation_request(argv[++i]);
		}
		if (license_path.empty()) {
			license_path = arg;
			continue;
		}
		cerr << "Unexpected argument: " << arg << endl;
		print_usage(argv[0]);
		return 1;
	}

	if (activation_request_mode) {
		return emit_activation_request(activation_feature);
	}

	char hw_identifier[LCC_API_PC_IDENTIFIER_SIZE + 1];
	ExecutionEnvironmentInfo exec_env_info;
	for (const auto& x : stringByStrategyId) {
		size_t bufSize = sizeof(hw_identifier);
		memset(hw_identifier, 0, sizeof(hw_identifier));
		if (identify_pc(static_cast<LCC_API_HW_IDENTIFICATION_STRATEGY>(x.first), hw_identifier, &bufSize,
						&exec_env_info)) {
			std::cout << x.second << ':' << hardware_value_for_output(hw_identifier, raw_hardware_output)
					  << std::endl;
		} else {
			std::cout << x.second << ": NA" << endl;
		}
	}
	cout << "Virtualiz. class :" << describe(descByVirt, exec_env_info.virtualization) << endl;
	cout << "Virtualiz. detail:" << describe(descByVirtDetail, exec_env_info.virtualization_detail) << endl;
	cout << "Cloud provider   :" << describe(descByCloudProvider, exec_env_info.cloud_provider) << endl;

	std::vector<license::os::OsAdapterInfo> adapterInfos;
	FUNCTION_RETURN ret = license::os::getAdapterInfos(adapterInfos);
	if (ret == FUNCTION_RETURN::FUNC_RET_OK) {
		for (auto osAdapter : adapterInfos) {
			cout << "Network adapter [" << hardware_value_for_output(osAdapter.id, raw_hardware_output)
				 << "]: " << hardware_value_for_output(osAdapter.description, raw_hardware_output) << endl;
			cout << "   ip address ["
				 << hardware_value_for_output(format_ipv4_address(osAdapter.ipv4_address), raw_hardware_output)
				 << "]" << endl;
			cout << "   mac address ["
				 << hardware_value_for_output(format_mac_address(osAdapter.mac_address), raw_hardware_output)
				 << "]" << endl;
		}
	} else {
		cout << "problem in getting adapter informations:" << ret << endl;
	}

	license::os::CpuInfo cpu;
	cout << "Cpu Vendor       :" << hardware_value_for_output(cpu.vendor(), raw_hardware_output) << endl;
	cout << "Cpu Brand        :" << hardware_value_for_output(cpu.brand(), raw_hardware_output) << endl;
	cout << "Cpu hypervisor   :" << hardware_value_for_output(cpu.is_hypervisor_set(), raw_hardware_output) << endl;
	ostringstream cpu_model;
	cpu_model << "0x" << std::hex << ((long)cpu.model());
	cout << "Cpu model        :" << hardware_value_for_output(cpu_model.str(), raw_hardware_output) << endl;
	license::os::DmiInfo dmi_info;
	cout << "Bios vendor      :" << hardware_value_for_output(dmi_info.bios_vendor(), raw_hardware_output) << endl;
	cout << "Bios description :" << hardware_value_for_output(dmi_info.bios_description(), raw_hardware_output) << endl;
	cout << "System vendor    :" << hardware_value_for_output(dmi_info.sys_vendor(), raw_hardware_output) << endl;
	cout << "Cpu Vendor (dmi) :" << hardware_value_for_output(dmi_info.cpu_manufacturer(), raw_hardware_output) << endl;
	cout << "Cpu Cores  (dmi) :" << hardware_value_for_output(dmi_info.cpu_cores(), raw_hardware_output) << endl;
	cout << "==================" << endl;
	if (!license_path.empty()) {
		ifstream license_file(license_path);
		if (license_file.good()) {
			verifyLicense(license_path);
		} else {
			cerr << "license file :" << license_path << " not found." << endl;
		}
	}
	bool find_license_with_env_var = FIND_LICENSE_WITH_ENV_VAR;
	if (find_license_with_env_var) {
		char* env_var_value = getenv(LCC_LICENSE_LOCATION_ENV_VAR);
		if (env_var_value != nullptr && env_var_value[0] != '\0') {
			// Redact the env-var value by default: a license path can carry user/host/tenant info
			// (audit R6.6). The file-open loop below still uses the raw value; only the echo is redacted.
			cout << "environment variable [" << LCC_LICENSE_LOCATION_ENV_VAR << "] value ["
				 << hardware_value_for_output(string(env_var_value), raw_hardware_output) << "]" << endl;
			const vector<string> declared_licenses = license::split_string(string(env_var_value), ';');
			for (string fname : declared_licenses) {
				ifstream license_file(fname);
				if (license_file.good()) {
					verifyLicense(fname);
				} else {
					cerr << "license file :" << fname << " not found." << endl;
				}
			}
		} else {
			cout << "environment variable [" << LCC_LICENSE_LOCATION_ENV_VAR << "] configured but not defined." << endl;
		}
	}
}
