/**
 * @file network.cpp
 * @date 16 Sep 2014
 * @brief File containing network interface detection functions for Windows.
 *
 * The only public function of this module is getAdapterInfos(), other
 * functions are either static or inline.
 *
 * Responsibility of this module is to fill OsAdapterInfo structures, in a predictable way (skip loopback/vpn interfaces)
 */

#define _CRTDBG_MAP_ALLOC
#define NOMINMAX

#ifdef _MSC_VER
#include <Windows.h>
#endif
#include <iphlpapi.h>
#include <unordered_map>
#include <stdio.h>
#pragma comment(lib, "IPHLPAPI.lib")

#include "../../base/string_utils.h"
#include "../../base/logger.h"
#include "../network.hpp"

#define MALLOC(x) HeapAlloc(GetProcessHeap(), 0, (x))
#define FREE(x) HeapFree(GetProcessHeap(), 0, (x))

namespace license {
namespace os {
using namespace std;

	/**
 *
 * @param adapterInfos output vector populated with network adapter details.
 * @return FUNC_RET_OK when adapters can be enumerated, otherwise an error code.
 */
FUNCTION_RETURN getAdapterInfos(vector<OsAdapterInfo> &adapterInfos) {
	vector<OsAdapterInfo> tmpAdapters;
	FUNCTION_RETURN f_return = FUNC_RET_OK;
	DWORD dwStatus;

	ULONG ulOutBufLen = sizeof(IP_ADAPTER_INFO) *10;
	IP_ADAPTER_INFO *pAdapterInfo = (IP_ADAPTER_INFO *)MALLOC(sizeof(IP_ADAPTER_INFO) * 10);

	if (pAdapterInfo == nullptr) {
		return FUNC_RET_ERROR;
	}

	dwStatus = GetAdaptersInfo(
		pAdapterInfo,  // [out] buffer to receive data
		&ulOutBufLen  // [in] size of receive data buffer
	);

	// Incase the buffer was too small, reallocate with the returned dwBufLen
	if (dwStatus == ERROR_BUFFER_OVERFLOW) {
		FREE(pAdapterInfo);
		pAdapterInfo = (IP_ADAPTER_INFO *)MALLOC(ulOutBufLen);

		// Will only fail if buffer cannot be allocated (out of memory)
		if (pAdapterInfo == nullptr) {
			return FUNC_RET_BUFFER_TOO_SMALL;
		}

		dwStatus = GetAdaptersInfo(	 // Call GetAdapterInfo
			pAdapterInfo,  // [out] buffer to receive data
			&ulOutBufLen  // [in] size of receive data buffer
		);

		switch (dwStatus) {
			case NO_ERROR:
				break;

			case ERROR_BUFFER_OVERFLOW:
				FREE(pAdapterInfo);
				return FUNC_RET_BUFFER_TOO_SMALL;

			default:
				FREE(pAdapterInfo);
				return FUNC_RET_ERROR;
		}
	}

	IP_ADAPTER_INFO* pAdapter = pAdapterInfo;
	while (pAdapter) {
		if (pAdapter->Type == MIB_IF_TYPE_ETHERNET) {
			OsAdapterInfo ai = {};
			LOG_DEBUG("Ethernet found %s, %s, mac_l: %d", pAdapter->AdapterName, pAdapter->Description, pAdapter->AddressLength);
			if (pAdapter->AddressLength > 0) {
				bool allzero = true;
				const size_t size_to_be_copied = std::min(sizeof(ai.mac_address), (size_t)pAdapter->AddressLength);
				for (int i = 0; i < size_to_be_copied && allzero; i++) {
					allzero = allzero && (pAdapter->Address[i] == 0);
				}
				if (!allzero) {
					strncpy(ai.description, pAdapter->Description,
						min(sizeof(ai.description) - 1, (size_t)MAX_ADAPTER_DESCRIPTION_LENGTH));
					memcpy(ai.mac_address, pAdapter->Address, size_to_be_copied);
					parse_ipv4_address(pAdapter->IpAddressList.IpAddress.String, ai.ipv4_address);
					ai.type = IFACE_TYPE_ETHERNET;
					tmpAdapters.push_back(ai);
				}
			}
		}
		pAdapter = pAdapter->Next;
	}
	if (pAdapterInfo!=nullptr) {
		FREE(pAdapterInfo);
	}

	if (tmpAdapters.size() == 0) {
		f_return = FUNC_RET_NOT_AVAIL;
	} else {
		sortAdapterInfos(tmpAdapters);
		if (tmpAdapters.size() == 0) {
			f_return = FUNC_RET_NOT_AVAIL;
		} else {
			adapterInfos = std::move(tmpAdapters);
		}
	}
	return f_return;
}

}  // namespace os
}  // namespace license
