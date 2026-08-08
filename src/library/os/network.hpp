/*
 * network.hpp
 *
 *  Created on: Feb 8, 2020
 *      Author: devel
 */

#ifndef SRC_LIBRARY_OS_NETWORK_HPP_
#define SRC_LIBRARY_OS_NETWORK_HPP_
#include <algorithm>
#include <cctype>
#include <cstddef>
#include <cstring>
#include <stdlib.h>
#include <string>
#include <vector>

#ifdef __unix__
#include <netdb.h>
#define LCC_ADAPTER_DESCRIPTION_LEN NI_MAXHOST
#else
//mingw cross compile for Windows
#ifdef _MSC_VER
#include <Windows.h>
#endif
#include <iphlpapi.h>
#define LCC_ADAPTER_DESCRIPTION_LEN MAX_ADAPTER_DESCRIPTION_LENGTH
#endif

#include "../base/base.h"

namespace license {
namespace os {

typedef enum { IFACE_TYPE_ETHERNET, IFACE_TYPE_WIRELESS } IFACE_TYPE;


typedef struct {
	int id;
	char description[LCC_ADAPTER_DESCRIPTION_LEN + 1];
	unsigned char mac_address[6];
	unsigned char ipv4_address[4];
	IFACE_TYPE type;
} OsAdapterInfo;

inline bool bytes_have_nonzero_value(const unsigned char *data, const std::size_t size) {
	for (std::size_t i = 0; i < size; ++i) {
		if (data[i] != 0) {
			return true;
		}
	}
	return false;
}

inline bool adapter_has_nonzero_mac(const OsAdapterInfo &adapter) {
	return bytes_have_nonzero_value(adapter.mac_address, sizeof(adapter.mac_address));
}

inline bool adapter_has_nonzero_ipv4(const OsAdapterInfo &adapter) {
	return bytes_have_nonzero_value(adapter.ipv4_address, sizeof(adapter.ipv4_address));
}

inline bool adapter_has_nonzero_identity(const OsAdapterInfo &adapter, const bool use_ip) {
	return use_ip ? adapter_has_nonzero_ipv4(adapter) : adapter_has_nonzero_mac(adapter);
}

inline std::string adapter_description_lower(const OsAdapterInfo &adapter) {
	const char *begin = adapter.description;
	const char *end = std::find(begin, begin + sizeof(adapter.description), '\0');
	std::string description(begin, end);
	std::transform(description.begin(), description.end(), description.begin(),
				   [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
	return description;
}

inline bool adapter_description_contains_any(const std::string &description, const char *const *terms,
											 const std::size_t term_count) {
	for (std::size_t i = 0; i < term_count; ++i) {
		if (description.find(terms[i]) != std::string::npos) {
			return true;
		}
	}
	return false;
}

inline bool adapter_description_starts_with_any(const std::string &description, const char *const *prefixes,
												const std::size_t prefix_count) {
	for (std::size_t i = 0; i < prefix_count; ++i) {
		if (description.compare(0, std::strlen(prefixes[i]), prefixes[i]) == 0) {
			return true;
		}
	}
	return false;
}

inline bool adapter_is_virtual_or_weak(const OsAdapterInfo &adapter) {
	const std::string description = adapter_description_lower(adapter);
	const char *const weak_terms[] = {
		"virtual", "vpn", "ppp", "tunnel", "docker", "hyper-v", "vmware", "virtualbox", "zerotier", "tailscale"
	};
	const char *const weak_prefixes[] = {"veth", "br-", "docker", "tun", "tap", "wg", "zt", "ppp"};
	return adapter_description_contains_any(description, weak_terms, sizeof(weak_terms) / sizeof(weak_terms[0])) ||
		   adapter_description_starts_with_any(description, weak_prefixes,
											  sizeof(weak_prefixes) / sizeof(weak_prefixes[0]));
}

inline bool adapter_has_known_physical_description(const OsAdapterInfo &adapter) {
	const std::string description = adapter_description_lower(adapter);
	const char *const physical_terms[] = {
		"realtek", "intel", "broadcom", "qualcomm", "atheros", "killer", "ethernet", "wireless", "wi-fi"
	};
	const char *const physical_prefixes[] = {"eth", "enp", "eno", "ens", "enx", "wlan", "wlp", "wlx", "ib"};
	return adapter_description_contains_any(description, physical_terms,
										   sizeof(physical_terms) / sizeof(physical_terms[0])) ||
		   adapter_description_starts_with_any(description, physical_prefixes,
											  sizeof(physical_prefixes) / sizeof(physical_prefixes[0]));
}

inline int adapter_identity_rank(const OsAdapterInfo &adapter) {
	const bool has_mac = adapter_has_nonzero_mac(adapter);
	const bool has_ipv4 = adapter_has_nonzero_ipv4(adapter);
	if (has_mac && has_ipv4) {
		return 0;
	}
	if (has_mac) {
		return 1;
	}
	if (has_ipv4) {
		return 2;
	}
	return 3;
}

inline bool adapter_bytes_less(const unsigned char *lhs, const unsigned char *rhs, const std::size_t size) {
	return std::lexicographical_compare(lhs, lhs + size, rhs, rhs + size);
}

inline int adapter_bytes_compare(const unsigned char *lhs, const unsigned char *rhs, const std::size_t size) {
	if (std::equal(lhs, lhs + size, rhs)) {
		return 0;
	}
	return adapter_bytes_less(lhs, rhs, size) ? -1 : 1;
}

inline bool adapter_sort_less(const OsAdapterInfo &lhs, const OsAdapterInfo &rhs) {
	const bool lhs_virtual = adapter_is_virtual_or_weak(lhs);
	const bool rhs_virtual = adapter_is_virtual_or_weak(rhs);
	if (lhs_virtual != rhs_virtual) {
		return !lhs_virtual;
	}

	const int lhs_identity_rank = adapter_identity_rank(lhs);
	const int rhs_identity_rank = adapter_identity_rank(rhs);
	if (lhs_identity_rank != rhs_identity_rank) {
		return lhs_identity_rank < rhs_identity_rank;
	}

	const bool lhs_known_physical = adapter_has_known_physical_description(lhs);
	const bool rhs_known_physical = adapter_has_known_physical_description(rhs);
	if (lhs_known_physical != rhs_known_physical) {
		return lhs_known_physical;
	}

	if (lhs.type != rhs.type) {
		return lhs.type < rhs.type;
	}

	const std::string lhs_description = adapter_description_lower(lhs);
	const std::string rhs_description = adapter_description_lower(rhs);
	if (lhs_description != rhs_description) {
		return lhs_description < rhs_description;
	}

	const int mac_compare = adapter_bytes_compare(lhs.mac_address, rhs.mac_address, sizeof(lhs.mac_address));
	if (mac_compare != 0) {
		return mac_compare < 0;
	}

	const int ipv4_compare = adapter_bytes_compare(lhs.ipv4_address, rhs.ipv4_address, sizeof(lhs.ipv4_address));
	if (ipv4_compare != 0) {
		return ipv4_compare < 0;
	}

	return lhs.id < rhs.id;
}

inline void sortAdapterInfos(std::vector<OsAdapterInfo> &adapters) {
	adapters.erase(std::remove_if(adapters.begin(), adapters.end(),
								  [](const OsAdapterInfo &adapter) {
									  return !adapter_has_nonzero_mac(adapter) && !adapter_has_nonzero_ipv4(adapter);
								  }),
				   adapters.end());
	std::sort(adapters.begin(), adapters.end(), adapter_sort_less);
	for (std::size_t i = 0; i < adapters.size(); ++i) {
		adapters[i].id = static_cast<int>(i);
	}
}

inline bool parse_ipv4_address(const char *input, unsigned char ipv4[4]) {
	if (input == nullptr) {
		return false;
	}
	unsigned int octets[4] = {};
	std::size_t octet_index = 0;
	unsigned int current = 0;
	bool have_digit = false;
	for (const unsigned char *cursor = reinterpret_cast<const unsigned char *>(input);; ++cursor) {
		const unsigned char ch = *cursor;
		if (std::isdigit(ch)) {
			have_digit = true;
			current = current * 10U + static_cast<unsigned int>(ch - '0');
			if (current > 255U) {
				return false;
			}
			continue;
		}
		if (ch != '.' && ch != '\0') {
			return false;
		}
		if (!have_digit || octet_index >= 4U) {
			return false;
		}
		octets[octet_index++] = current;
		current = 0;
		have_digit = false;
		if (ch == '\0') {
			break;
		}
		if (octet_index >= 4U) {
			return false;
		}
	}
	if (octet_index != 4U) {
		return false;
	}
	for (std::size_t i = 0; i < 4U; ++i) {
		ipv4[i] = static_cast<unsigned char>(octets[i]);
	}
	return true;
}

FUNCTION_RETURN getAdapterInfos(std::vector<OsAdapterInfo>& adapterInfos);

}  // namespace os
}  // namespace license
#endif /* SRC_LIBRARY_OS_NETWORK_HPP_ */
