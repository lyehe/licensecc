/*
 *
 *  Created on: Feb 23, 2020
 *      Author: GC
 */

#include <stdio.h>
#include <string.h>
#include <algorithm>
#include <cctype>
#include <unordered_map>
#include <array>
#include <licensecc/datatypes.h>

#include "../base/base.h"
#include "cpu_info.hpp"
#include "execution_environment.hpp"

namespace license {
namespace os {
using namespace std;

const unordered_map<string, LCC_API_VIRTUALIZATION_DETAIL> virtual_cpu_names{
	{"bhyve bhyve ", V_OTHER}, {"KVM", KVM},	   {"MICROSOFT", HV},		{" lrpepyh vr", HV},
	{"prl hyperv  ", PARALLELS}, {"VMWARE", VMWARE}, {"XenVMMXenVMM", V_XEN}, {"ACRNACRNACRN", V_OTHER},
	{"VBOX", VIRTUALBOX}};

const unordered_map<string, LCC_API_VIRTUALIZATION_DETAIL> vm_vendors{{"VMWARE", VMWARE},
																	  {"MICROSOFT", HV},
																	  {"PARALLELS", PARALLELS},
																	  {"VIRTUAL MACHINE", V_OTHER},
																	  {"INNOTEK GMBH", VIRTUALBOX},
																	  {"POWERVM", V_OTHER},
																	  {"BOCHS", V_OTHER},
																	  {"KVM", KVM}};

static LCC_API_VIRTUALIZATION_DETAIL find_in_map(const unordered_map<string, LCC_API_VIRTUALIZATION_DETAIL>& map,
												 const string& data) {
	for (auto it : map) {
		if (data.find(it.first) != string::npos) {
			return it.second;
		}
	}
	return BARE_TO_METAL;
}

LCC_API_VIRTUALIZATION_SUMMARY ExecutionEnvironment::virtualization() const {
	LCC_API_VIRTUALIZATION_SUMMARY result;
	bool isContainer = is_container();
	if (isContainer) {
		result = LCC_API_VIRTUALIZATION_SUMMARY::CONTAINER;
	} else if (virtualization_detail() != BARE_TO_METAL || is_cloud()) {
		result = LCC_API_VIRTUALIZATION_SUMMARY::VM;
	} else {
		result = LCC_API_VIRTUALIZATION_SUMMARY::NONE;
	}
	return result;
}

LCC_API_VIRTUALIZATION_DETAIL ExecutionEnvironment::virtualization_detail() const {
	LCC_API_VIRTUALIZATION_DETAIL result = BARE_TO_METAL;
	const string bios_description = m_dmi_info.bios_description();
	const string bios_vendor = m_dmi_info.bios_vendor();
	const string sys_vendor = m_dmi_info.sys_vendor();
	if ((result = find_in_map(vm_vendors, bios_description)) == BARE_TO_METAL) {
		if ((result = find_in_map(vm_vendors, bios_vendor)) == BARE_TO_METAL) {
			if ((result = find_in_map(vm_vendors, sys_vendor)) == BARE_TO_METAL) {
				if ((result = find_in_map(virtual_cpu_names, m_cpu_info.vendor())) == BARE_TO_METAL) {
					result = find_in_map(virtual_cpu_names, m_cpu_info.brand());
				}
			}
		}
	}
	if (result == BARE_TO_METAL) {
		if (m_cpu_info.is_hypervisor_set() || is_cloud()) {
			result = V_OTHER;
		}
	}
	return result;
}

bool ExecutionEnvironment::is_cloud() const {
	const LCC_API_CLOUD_PROVIDER prov = cloud_provider();
	return prov != ON_PREMISE && prov != PROV_UNKNOWN;
}

static string upper_ascii(string value) {
	transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
		return static_cast<char>(toupper(ch));
	});
	return value;
}

LCC_API_CLOUD_PROVIDER classify_cloud_provider(const string& raw_bios_description, const string& raw_bios_vendor,
											 const string& raw_sys_vendor, const string& raw_chassis_asset_tag) {
	LCC_API_CLOUD_PROVIDER result = PROV_UNKNOWN;
	const string bios_description = upper_ascii(raw_bios_description);
	const string bios_vendor = upper_ascii(raw_bios_vendor);
	const string sys_vendor = upper_ascii(raw_sys_vendor);
	const string chassis_asset_tag = upper_ascii(raw_chassis_asset_tag);
	if (!bios_description.empty() || !bios_vendor.empty() || !sys_vendor.empty() || !chassis_asset_tag.empty()) {
		// Azure and Azure Stack currently expose this well-known SMBIOS chassis asset tag. Do not classify a
		// generic Microsoft/Hyper-V guest as Azure: the same system-vendor strings are common on-premises.
		if (chassis_asset_tag == "7783-7084-3265-9085-8269-3286-77") {
			result = AZURE_CLOUD;
		} else if (bios_description.find("ALIBABA") != string::npos || sys_vendor.find("ALIBABA") != string::npos ||
				   sys_vendor.find("ALIBABA CLOUD") != string::npos) {
			result = ALI_CLOUD;
		} else if (sys_vendor.find("GOOGLE") != string::npos ||
				   bios_description.find("GOOGLECOMPUTEENGINE") != string::npos) {
			result = GOOGLE_CLOUD;
		} else if (bios_vendor.find("AWS") != string::npos || bios_description.find("AMAZON") != string::npos ||
				   sys_vendor.find("AWS") != string::npos) {
			result = AWS;
		} else if (bios_description.find("HP-COMPAQ") != string::npos ||
				   bios_description.find("ASUS") != string::npos || bios_description.find("DELL") != string::npos) {
			result = ON_PREMISE;
		}
	}
	return result;
}

LCC_API_CLOUD_PROVIDER ExecutionEnvironment::cloud_provider() const {
	return classify_cloud_provider(m_dmi_info.bios_description(), m_dmi_info.bios_vendor(), m_dmi_info.sys_vendor(),
								   m_dmi_info.chassis_asset_tag());
}
}  // namespace os
}  // namespace license
