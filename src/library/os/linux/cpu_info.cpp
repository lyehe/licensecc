/*
 * cpu_info.cpp
 *
 *  Created on: Dec 14, 2019
 *      Author: devel
 */

#include <string>

#if defined(__aarch64__) || defined(__arm__)
#define LCC_LINUX_NON_X86_CPU_INFO 1
#elif defined(__i386__) || defined(__x86_64__)
#define LCC_LINUX_X86_CPU_INFO 1
#else
#define LCC_LINUX_NON_X86_CPU_INFO 1
#endif

#if defined(LCC_LINUX_X86_CPU_INFO)
#include <cpuid.h>
#include <cstring>
#else
#include <sys/utsname.h>
#endif

#include "../cpu_info.hpp"

namespace license {
namespace os {
using namespace std;

#if defined(LCC_LINUX_X86_CPU_INFO)
struct CPUVendorID {
	uint32_t ebx;
	uint32_t edx;
	uint32_t ecx;

	string toString() const { return string(reinterpret_cast<const char *>(this), 12); }
};

static string get_cpu_vendor() {
	unsigned int level = 0, eax = 0, ebx = 0, ecx = 0, edx = 0;
	// hypervisor flag false, try to get the vendor name, see if it's a virtual cpu
	__get_cpuid(level, &eax, &ebx, &ecx, &edx);
	CPUVendorID vendorID{.ebx = ebx, .edx = edx, .ecx = ecx};
	return vendorID.toString();
}

// https://en.wikipedia.org/wiki/CPUID
static string get_cpu_brand() {
	string result;
	uint32_t brand[0x10];

	if (!__get_cpuid_max(0x80000004, NULL)) {
		result = "NA";
	} else {
		memset(brand, 0, sizeof(brand));
		__get_cpuid(0x80000002, brand + 0x0, brand + 0x1, brand + 0x2, brand + 0x3);
		__get_cpuid(0x80000003, brand + 0x4, brand + 0x5, brand + 0x6, brand + 0x7);
		__get_cpuid(0x80000004, brand + 0x8, brand + 0x9, brand + 0xa, brand + 0xb);
		result = string(reinterpret_cast<char *>(brand));
	}
	return result;
}
#else
static string get_cpu_vendor() {
#if defined(__aarch64__) || defined(__arm__)
	return "ARM";
#else
	return "NON-X86";
#endif
}

static string get_non_x86_cpu_brand() {
	struct utsname info = {};
	if (uname(&info) == 0 && info.machine[0] != '\0') {
		return info.machine;
	}
	return "NA";
}

static string get_cpu_brand() { return get_non_x86_cpu_brand(); }
#endif

CpuInfo::CpuInfo() : m_vendor(get_cpu_vendor()), m_brand(get_cpu_brand()) {}

CpuInfo::~CpuInfo() {}
/**
 * Detect Virtual machine using hypervisor bit.
 * @return true if the cpu hypervisor bit is set to 1
 */
bool CpuInfo::is_hypervisor_set() const {
#if defined(LCC_LINUX_X86_CPU_INFO)
	uint32_t level = 1, eax = 0, ebx = 0, ecx = 0, edx = 0;
	__get_cpuid(level, &eax, &ebx, &ecx, &edx);

	bool is_virtual = (((ecx >> 31) & 1) == 1);	 // hypervisor flag
	return is_virtual;
#else
	// Arm has no architecture-equivalent CPUID hypervisor bit. Linux Arm
	// virtualization remains detectable through the existing DMI and cloud
	// provider signals used by ExecutionEnvironment.
	return false;
#endif
}

uint32_t CpuInfo::model() const {
#if defined(LCC_LINUX_X86_CPU_INFO)
	uint32_t level = 1, eax = 0, ebx = 0, ecx = 0, edx = 0;
	__get_cpuid(level, &eax, &ebx, &ecx, &edx);
	// ax bits 0-3 stepping,4-7 model,8-11 family id,12-13 processor type
	//        14-15 reserved, 16-19 extended model, 20-27 extended family, 27-31 reserved
	// bx bits 0-7 brand index
	return (eax & 0x3FFF) | (eax & 0x3FF8000) >> 2 | (ebx & 0xff) << 24;
#else
	// The public inspector exposes an x86 CPUID model value. Zero is the
	// explicit unknown value on architectures without that encoding.
	return 0;
#endif
}

}  // namespace os
} /* namespace license */

#undef LCC_LINUX_X86_CPU_INFO
#undef LCC_LINUX_NON_X86_CPU_INFO
