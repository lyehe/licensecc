#include <iostream>
#include <vector>
#include <map>
#include <unordered_map>
#include <licensecc/licensecc.h>
#include <fstream>
#include <string.h>
#include <iomanip>
#include <sstream>
#include "../library/base/string_utils.h"
#include "../library/ini/SimpleIni.h"
#include "../library/os/dmi_info.hpp"
#include "../library/os/cpu_info.hpp"
#include "../library/os/dmi_info.hpp"
#include "../library/os/network.hpp"

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
	return 0;
}

static void print_usage(const char* program_name) {
	cout << "Usage: " << program_name << " [--raw-hardware-identifiers] [license-file]" << endl;
	cout << "Hardware identifiers, IP addresses, and MAC addresses are redacted by default." << endl;
	cout << "Use --raw-hardware-identifiers only for trusted diagnostic handoff." << endl;
}

static LCC_EVENT_TYPE verifyLicense(const string& fname) {
	LicenseInfo licenseInfo;
	LicenseLocation licLocation = {LICENSE_PATH};
	std::copy(fname.begin(), fname.end(), licLocation.licenseData);
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
		const string section_name(section.pItem, 15);
		if (section_name != LCC_PROJECT_NAME) {
			std::copy(section_name.begin(), section_name.end(), callerInformation.feature_name);
			LCC_EVENT_TYPE result = acquire_license(&callerInformation, &licLocation, &licenseInfo);
			if (result == LICENSE_OK) {
				cout << "project [" << section.pItem << "]: license OK" << endl;
			} else {
				cerr << "project [" << section.pItem << "]: " << lcc_strerror(result) << endl;
			}
		}
	}
	return result;
}

int main(int argc, char* argv[]) {
	bool raw_hardware_output = false;
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
		if (license_path.empty()) {
			license_path = arg;
			continue;
		}
		cerr << "Unexpected argument: " << arg << endl;
		print_usage(argv[0]);
		return 1;
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
	cout << "Virtualiz. class :" << descByVirt.find(exec_env_info.virtualization)->second << endl;
	cout << "Virtualiz. detail:" << descByVirtDetail.find(exec_env_info.virtualization_detail)->second << endl;
	cout << "Cloud provider   :" << descByCloudProvider.find(exec_env_info.cloud_provider)->second << endl;

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
			cout << "environment variable [" << LCC_LICENSE_LOCATION_ENV_VAR << "] value [" << env_var_value << "]"
				 << endl;
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
