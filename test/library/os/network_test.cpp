#define BOOST_TEST_MODULE network_test
#include <algorithm>
#include <cstring>
#include <initializer_list>
#include <string>
#include <iostream>
#include <vector>
#include <boost/test/unit_test.hpp>

#include <licensecc_properties.h>
#include <licensecc_properties_test.h>
#include "../../../src/library/base/string_utils.h"
#include "../../../src/library/os/network.hpp"
#include "../../../src/library/os/execution_environment.hpp"

namespace license {
namespace os {
namespace test {

using namespace license::os;
using namespace std;

static OsAdapterInfo make_adapter(const char *description, std::initializer_list<unsigned char> mac,
								  std::initializer_list<unsigned char> ipv4,
								  IFACE_TYPE type = IFACE_TYPE_ETHERNET) {
	OsAdapterInfo adapter = {};
	license::mstrlcpy(adapter.description, description, sizeof(adapter.description));
	adapter.type = type;

	std::size_t index = 0;
	for (const unsigned char value : mac) {
		if (index < sizeof(adapter.mac_address)) {
			adapter.mac_address[index++] = value;
		}
	}

	index = 0;
	for (const unsigned char value : ipv4) {
		if (index < sizeof(adapter.ipv4_address)) {
			adapter.ipv4_address[index++] = value;
		}
	}
	return adapter;
}

BOOST_AUTO_TEST_CASE(network_helpers_detect_nonzero_identity) {
	OsAdapterInfo adapter = {};

	BOOST_CHECK(!adapter_has_nonzero_mac(adapter));
	BOOST_CHECK(!adapter_has_nonzero_ipv4(adapter));
	BOOST_CHECK(!adapter_has_nonzero_identity(adapter, false));
	BOOST_CHECK(!adapter_has_nonzero_identity(adapter, true));

	adapter.mac_address[5] = 1;
	BOOST_CHECK(adapter_has_nonzero_mac(adapter));
	BOOST_CHECK(adapter_has_nonzero_identity(adapter, false));
	BOOST_CHECK(!adapter_has_nonzero_identity(adapter, true));

	adapter.ipv4_address[0] = 192;
	adapter.ipv4_address[1] = 168;
	adapter.ipv4_address[2] = 1;
	adapter.ipv4_address[3] = 20;
	BOOST_CHECK(adapter_has_nonzero_ipv4(adapter));
	BOOST_CHECK(adapter_has_nonzero_identity(adapter, true));
}

BOOST_AUTO_TEST_CASE(parse_ipv4_address_accepts_bounded_octets) {
	unsigned char ipv4[4] = {};

	BOOST_REQUIRE(parse_ipv4_address("192.168.1.20", ipv4));
	BOOST_CHECK_EQUAL(static_cast<int>(ipv4[0]), 192);
	BOOST_CHECK_EQUAL(static_cast<int>(ipv4[1]), 168);
	BOOST_CHECK_EQUAL(static_cast<int>(ipv4[2]), 1);
	BOOST_CHECK_EQUAL(static_cast<int>(ipv4[3]), 20);

	BOOST_REQUIRE(parse_ipv4_address("010.000.001.255", ipv4));
	BOOST_CHECK_EQUAL(static_cast<int>(ipv4[0]), 10);
	BOOST_CHECK_EQUAL(static_cast<int>(ipv4[1]), 0);
	BOOST_CHECK_EQUAL(static_cast<int>(ipv4[2]), 1);
	BOOST_CHECK_EQUAL(static_cast<int>(ipv4[3]), 255);
}

BOOST_AUTO_TEST_CASE(parse_ipv4_address_rejects_malformed_octets) {
	const char *invalid_inputs[] = {
		"",
		"1.2.3",
		"1.2.3.4.5",
		"1..2.3",
		".1.2.3",
		"1.2.3.",
		"256.1.2.3",
		"1.2.3.999",
		"1.2.3.a",
		"1.2.3.4x",
		"1:2:3:4",
		" 1.2.3.4",
		"1.2.3.4 "
	};

	unsigned char ipv4[4] = {7, 7, 7, 7};
	BOOST_CHECK(!parse_ipv4_address(nullptr, ipv4));
	BOOST_CHECK_EQUAL(static_cast<int>(ipv4[0]), 7);
	BOOST_CHECK_EQUAL(static_cast<int>(ipv4[1]), 7);
	BOOST_CHECK_EQUAL(static_cast<int>(ipv4[2]), 7);
	BOOST_CHECK_EQUAL(static_cast<int>(ipv4[3]), 7);

	for (const char *input : invalid_inputs) {
		ipv4[0] = 7;
		ipv4[1] = 7;
		ipv4[2] = 7;
		ipv4[3] = 7;
		BOOST_CHECK_MESSAGE(!parse_ipv4_address(input, ipv4), "Accepted malformed IPv4 input: " << input);
		BOOST_CHECK_EQUAL(static_cast<int>(ipv4[0]), 7);
		BOOST_CHECK_EQUAL(static_cast<int>(ipv4[1]), 7);
		BOOST_CHECK_EQUAL(static_cast<int>(ipv4[2]), 7);
		BOOST_CHECK_EQUAL(static_cast<int>(ipv4[3]), 7);
	}
}

BOOST_AUTO_TEST_CASE(sort_adapter_infos_deprioritizes_virtual_and_filters_empty_identity) {
	std::vector<OsAdapterInfo> adapters = {
		make_adapter("veth0", {0x02, 0x42, 0xac, 0x11, 0x00, 0x02}, {172, 17, 0, 2}),
		make_adapter("adapter-empty", {}, {}),
		make_adapter("enp0s3", {}, {192, 168, 1, 20}),
		make_adapter("eth0", {0x10, 0x20, 0x30, 0x40, 0x50, 0x60}, {})
	};

	sortAdapterInfos(adapters);

	BOOST_REQUIRE_EQUAL(adapters.size(), 3U);
	BOOST_CHECK_EQUAL(std::string(adapters[0].description), "eth0");
	BOOST_CHECK_EQUAL(adapters[0].id, 0);
	BOOST_CHECK(adapter_has_nonzero_mac(adapters[0]));
	BOOST_CHECK_EQUAL(std::string(adapters[1].description), "enp0s3");
	BOOST_CHECK_EQUAL(adapters[1].id, 1);
	BOOST_CHECK(adapter_has_nonzero_ipv4(adapters[1]));
	BOOST_CHECK_EQUAL(std::string(adapters[2].description), "veth0");
	BOOST_CHECK_EQUAL(adapters[2].id, 2);
	BOOST_CHECK(adapter_is_virtual_or_weak(adapters[2]));
}

BOOST_AUTO_TEST_CASE(sort_adapter_infos_uses_stable_name_and_byte_tie_breakers) {
	std::vector<OsAdapterInfo> adapters = {
		make_adapter("adapter-c", {0, 0, 0, 0, 0, 2}, {}),
		make_adapter("adapter-b", {0, 0, 0, 0, 0, 3}, {}),
		make_adapter("adapter-c", {0, 0, 0, 0, 0, 1}, {}),
		make_adapter("adapter-a", {0, 0, 0, 0, 0, 4}, {})
	};

	sortAdapterInfos(adapters);

	BOOST_REQUIRE_EQUAL(adapters.size(), 4U);
	BOOST_CHECK_EQUAL(std::string(adapters[0].description), "adapter-a");
	BOOST_CHECK_EQUAL(std::string(adapters[1].description), "adapter-b");
	BOOST_REQUIRE_EQUAL(std::string(adapters[2].description), "adapter-c");
	BOOST_REQUIRE_EQUAL(std::string(adapters[3].description), "adapter-c");
	BOOST_CHECK_EQUAL(static_cast<int>(adapters[2].mac_address[5]), 1);
	BOOST_CHECK_EQUAL(static_cast<int>(adapters[3].mac_address[5]), 2);
}

BOOST_AUTO_TEST_CASE(sort_adapter_infos_is_independent_of_input_order) {
	std::vector<OsAdapterInfo> forward = {
		make_adapter("docker0", {0x02, 0x42, 0xac, 0x11, 0x00, 0x01}, {172, 17, 0, 1}),
		make_adapter("wlan0", {0x70, 0x71, 0xbc, 0x00, 0x00, 0x02}, {10, 0, 0, 12}),
		make_adapter("eth0", {0x60, 0x61, 0xbc, 0x00, 0x00, 0x01}, {10, 0, 0, 11})
	};
	std::vector<OsAdapterInfo> reversed = forward;
	std::reverse(reversed.begin(), reversed.end());

	sortAdapterInfos(forward);
	sortAdapterInfos(reversed);

	BOOST_REQUIRE_EQUAL(forward.size(), reversed.size());
	for (std::size_t i = 0; i < forward.size(); ++i) {
		BOOST_CHECK_EQUAL(std::string(forward[i].description), std::string(reversed[i].description));
		BOOST_CHECK_EQUAL(std::memcmp(forward[i].mac_address, reversed[i].mac_address,
									  sizeof(forward[i].mac_address)), 0);
		BOOST_CHECK_EQUAL(std::memcmp(forward[i].ipv4_address, reversed[i].ipv4_address,
									  sizeof(forward[i].ipv4_address)), 0);
		BOOST_CHECK_EQUAL(forward[i].id, static_cast<int>(i));
		BOOST_CHECK_EQUAL(reversed[i].id, static_cast<int>(i));
	}
}

BOOST_AUTO_TEST_CASE(sort_adapter_infos_prefers_ethernet_before_wireless_when_strength_matches) {
	std::vector<OsAdapterInfo> adapters = {
		make_adapter("wlan0", {0x10, 0x20, 0x30, 0x40, 0x50, 0x61}, {}, IFACE_TYPE_WIRELESS),
		make_adapter("eth0", {0x10, 0x20, 0x30, 0x40, 0x50, 0x60}, {}, IFACE_TYPE_ETHERNET)
	};

	sortAdapterInfos(adapters);

	BOOST_REQUIRE_EQUAL(adapters.size(), 2U);
	BOOST_CHECK_EQUAL(std::string(adapters[0].description), "eth0");
	BOOST_CHECK_EQUAL(std::string(adapters[1].description), "wlan0");
	BOOST_CHECK_EQUAL(adapters[0].id, 0);
	BOOST_CHECK_EQUAL(adapters[1].id, 1);
}

BOOST_AUTO_TEST_CASE(read_network_adapters) {
	std::vector<license::os::OsAdapterInfo> adapters;
	// we can suppose every test environment other than docker has at least
	// one network interface
	FUNCTION_RETURN result = getAdapterInfos(adapters);
	ExecutionEnvironment exec_env;
	if (result != FUNC_RET_OK && exec_env.is_docker()) {
		BOOST_TEST_MESSAGE("detected docker environment, not having network interfaces is normal here");
		return;
	}
	BOOST_CHECK_EQUAL(result, FUNC_RET_OK);
	BOOST_CHECK_GT(adapters.size(),0);
	for (auto& it : adapters) {
		cout << "Interface found: " << string(it.description) << endl;
		BOOST_CHECK_GT(strlen(it.description), 0);
		// lo mac address is always 0 but it has ip
		// other interfaces may not be connected
		if (string(it.description) == "lo") {
			BOOST_FAIL("loopback adapters shouldn't appear");
		} else {
			const bool has_mac = adapter_has_nonzero_mac(it);
			const bool has_ipv4 = adapter_has_nonzero_ipv4(it);
			BOOST_CHECK_MESSAGE(has_mac || has_ipv4,
								"Interface " << it.description << " has neither a non-zero MAC nor IPv4 address");
		}
	}
}

}  // namespace test
}  // namespace os
}  // namespace license
