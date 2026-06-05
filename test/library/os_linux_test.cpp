#define BOOST_TEST_MODULE os_linux_test
#include <algorithm>
#include <array>
#include <string>
#include <iostream>
#include <unordered_map>
#include <boost/test/unit_test.hpp>

#include <licensecc_properties.h>
#include <licensecc_properties_test.h>
#include "../../src/library/base/string_utils.h"
#include "../../src/library/os/os.h"
#include "../../src/library/os/execution_environment.hpp"

FUNCTION_RETURN parse_blkid(const std::string &blkid_file_content, std::vector<DiskInfo> &diskInfos_out,
							std::unordered_map<std::string, int> &disk_by_uuid);
bool markLinuxPreferredDiskForFstabSource(std::vector<DiskInfo> &diskInfos,
										  std::unordered_map<std::string, int> &disk_by_uuid,
										  const std::string &fstab_source);
void sortLinuxDiskInfos(std::vector<DiskInfo> &diskInfos);

namespace license {
namespace test {
using namespace std;
// using namespace os;

static DiskInfo make_linux_disk_info(const int id, const char *device, const char *label, const char *volume_id,
									 const std::array<unsigned char, 8> &disk_sn, const bool preferred) {
	DiskInfo disk_info = {};
	disk_info.id = id;
	mstrlcpy(disk_info.device, device, sizeof(disk_info.device));
	if (label != nullptr) {
		mstrlcpy(disk_info.label, label, sizeof(disk_info.label));
		disk_info.label_initialized = true;
	}
	if (volume_id != nullptr) {
		mstrlcpy(disk_info.volume_id, volume_id, sizeof(disk_info.volume_id));
		disk_info.volume_id_initialized = true;
	}
	std::copy(disk_sn.begin(), disk_sn.end(), disk_info.disk_sn);
	disk_info.sn_initialized = true;
	disk_info.preferred = preferred;
	return disk_info;
}

BOOST_AUTO_TEST_CASE(read_disk_id) {
	os::ExecutionEnvironment exec_env;
	LCC_API_VIRTUALIZATION_SUMMARY virt = exec_env.virtualization();
	vector<DiskInfo> disk_infos;
	FUNCTION_RETURN result = getDiskInfos(disk_infos);
	if (virt == LCC_API_VIRTUALIZATION_SUMMARY::NONE || virt == LCC_API_VIRTUALIZATION_SUMMARY::VM) {
		BOOST_CHECK_EQUAL(result, FUNC_RET_OK);
		BOOST_REQUIRE_MESSAGE(disk_infos.size() > 0, "Found some disk");
		bool preferred_found = false;
		bool uuid_found = false;
		bool label_found = false;

		for (auto disk_info : disk_infos) {
			uuid_found = uuid_found || disk_info.sn_initialized;
			preferred_found = preferred_found || disk_info.preferred;
			label_found = label_found || disk_info.label_initialized;

			if (disk_info.sn_initialized) {
				bool all_zero = true;
				for (int i = 0; i < sizeof(disk_info.disk_sn) && all_zero; i++) {
					all_zero = (disk_info.disk_sn[i] == 0);
				}
				BOOST_CHECK_MESSAGE(!all_zero, "disksn is not all zero");
			}
		}
		BOOST_CHECK_MESSAGE(uuid_found, "At least one UUID initialized");
		BOOST_CHECK_MESSAGE(label_found, "At least one label found");
		BOOST_CHECK_MESSAGE(preferred_found, "At least one standard mounted file system");
	} else if (virt == LCC_API_VIRTUALIZATION_SUMMARY::CONTAINER) {
		// in docker or lxc diskInfo is very likely not to find any good disk.
		BOOST_CHECK_EQUAL(result, FUNC_RET_NOT_AVAIL);
		BOOST_REQUIRE_MESSAGE(disk_infos.size() == 0, "Found no disk");
	}
}

BOOST_AUTO_TEST_CASE(parse_blkid_file) {
	const string blkid_content =
		"<device DEVNO=\"0x0803\" TIME=\"1603155692.238672\" "
		"UUID=\"baccfd49-5203-4e34-9b8b-a2bbaf9b4e24\" TYPE=\"swap\" PARTLABEL=\"Linux swap\" "
		"PARTUUID=\"7d84b1a8-5492-4651-b720-61c723fb8c69\">/dev/sda3</device>"
		"<device DEVNO=\"0x10302\" TIME=\"1603155692.253094\" UUID=\"d1b5b096-5e58-4e4f-af39-be12038c9bed\" "
		"TYPE=\"ext4\" PARTLABEL=\"Linux filesystem\" PARTUUID=\"3d742821-3167-43fa-9f22-e9bea9a9ce64\">"
		"/dev/nvme0n1p2</device>";
	vector<DiskInfo> disk_infos;
	std::unordered_map<std::string, int> disk_by_uuid;
	FUNCTION_RETURN result = parse_blkid(blkid_content, disk_infos, disk_by_uuid);
	BOOST_CHECK_EQUAL(result, FUNC_RET_OK);
	BOOST_CHECK_MESSAGE(disk_infos.size() == 2, "Two disks found");
	BOOST_CHECK_MESSAGE(string("Linux swap") == disk_infos[0].label, "Label parsed OK");
	BOOST_CHECK_MESSAGE(string("/dev/sda3") == disk_infos[0].device, "device parsed");
	BOOST_CHECK_MESSAGE(string("swap") == disk_infos[0].filesystem, "filesystem parsed");
	BOOST_CHECK(disk_infos[0].filesystem_initialized);
	BOOST_CHECK_MESSAGE(string("baccfd49-5203-4e34-9b8b-a2bbaf9b4e24") == disk_infos[0].volume_id,
						"UUID preserved");
	BOOST_CHECK(disk_infos[0].volume_id_initialized);
	BOOST_CHECK_MESSAGE(disk_infos[0].preferred, "Preferred found");
}

/**
 * Regression test for the parseUUID heap overflow: a dash-free, all-hex UUID
 * makes the number of hex digits equal the source length (even count, no pad),
 * and an odd count forces a pad. Both used to write past the allocated buffer.
 * Reached indirectly through parse_blkid, which calls the file-local parseUUID.
 */
BOOST_AUTO_TEST_CASE(parse_uuid_no_overflow) {
	const string blkid_content =
		"<device UUID=\"abcdef0123456789\" TYPE=\"ext4\" PARTLABEL=\"even\">/dev/sdz1</device>"
		"<device UUID=\"abc\" TYPE=\"ext4\" PARTLABEL=\"odd\">/dev/sdz2</device>";
	vector<DiskInfo> disk_infos;
	std::unordered_map<std::string, int> disk_by_uuid;
	FUNCTION_RETURN result = parse_blkid(blkid_content, disk_infos, disk_by_uuid);
	BOOST_CHECK_EQUAL(result, FUNC_RET_OK);
	BOOST_REQUIRE_MESSAGE(disk_infos.size() == 2, "Two disks parsed");

	// "abcdef0123456789" -> bytes ab cd ef 01 23 45 67 89 (XOR-folded into 8 bytes = identity)
	const unsigned char expected_even[8] = {0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89};
	for (int i = 0; i < 8; i++) {
		BOOST_CHECK_EQUAL(disk_infos[0].disk_sn[i], expected_even[i]);
	}
	// "abc" -> padded to "abc0" -> bytes ab c0
	BOOST_CHECK_EQUAL(disk_infos[1].disk_sn[0], 0xab);
	BOOST_CHECK_EQUAL(disk_infos[1].disk_sn[1], 0xc0);
}

BOOST_AUTO_TEST_CASE(fstab_source_matching_updates_actual_disk_entries) {
	const std::array<unsigned char, 8> first_sn = {0x01, 0, 0, 0, 0, 0, 0, 0};
	const std::array<unsigned char, 8> second_sn = {0x02, 0, 0, 0, 0, 0, 0, 0};
	const std::array<unsigned char, 8> third_sn = {0x03, 0, 0, 0, 0, 0, 0, 0};
	vector<DiskInfo> disk_infos = {
		make_linux_disk_info(10, "sda1", "ROOT", "11111111-1111-1111-1111-111111111111", first_sn, false),
		make_linux_disk_info(20, "nvme0n1p2", "DATA", "22222222-2222-2222-2222-222222222222", second_sn, false),
		make_linux_disk_info(30, "sdb1", "BACKUP", "33333333-3333-3333-3333-333333333333", third_sn, false)
	};
	std::unordered_map<std::string, int> disk_by_uuid = {
		{"11111111-1111-1111-1111-111111111111", 10},
		{"22222222-2222-2222-2222-222222222222", 20},
		{"33333333-3333-3333-3333-333333333333", 30}
	};

	BOOST_CHECK(markLinuxPreferredDiskForFstabSource(disk_infos, disk_by_uuid,
													"UUID=11111111-1111-1111-1111-111111111111"));
	BOOST_CHECK(disk_infos[0].preferred);

	BOOST_CHECK(markLinuxPreferredDiskForFstabSource(disk_infos, disk_by_uuid, "LABEL=DATA"));
	BOOST_CHECK(disk_infos[1].preferred);

	BOOST_CHECK(markLinuxPreferredDiskForFstabSource(disk_infos, disk_by_uuid, "/dev/sdb1"));
	BOOST_CHECK(disk_infos[2].preferred);
}

BOOST_AUTO_TEST_CASE(fstab_source_matching_reports_missing_metadata) {
	const std::array<unsigned char, 8> disk_sn = {0x01, 0, 0, 0, 0, 0, 0, 0};
	vector<DiskInfo> disk_infos = {
		make_linux_disk_info(10, "sda1", "ROOT", "11111111-1111-1111-1111-111111111111", disk_sn, false)
	};
	std::unordered_map<std::string, int> disk_by_uuid = {{"11111111-1111-1111-1111-111111111111", 10}};

	BOOST_CHECK(!markLinuxPreferredDiskForFstabSource(disk_infos, disk_by_uuid,
													 "UUID=22222222-2222-2222-2222-222222222222"));
	BOOST_CHECK(!markLinuxPreferredDiskForFstabSource(disk_infos, disk_by_uuid, "LABEL=MISSING"));
	BOOST_CHECK(!markLinuxPreferredDiskForFstabSource(disk_infos, disk_by_uuid, "/dev/missing"));
	BOOST_CHECK(!disk_infos[0].preferred);
}

BOOST_AUTO_TEST_CASE(sort_linux_disk_infos_is_stable_and_prefers_strong_metadata) {
	const std::array<unsigned char, 8> zero_sn = {};
	const std::array<unsigned char, 8> preferred_sn = {0x20, 0, 0, 0, 0, 0, 0, 0};
	const std::array<unsigned char, 8> data_sn = {0x10, 0, 0, 0, 0, 0, 0, 0};
	vector<DiskInfo> disk_infos = {
		make_linux_disk_info(40, "zlabel", "LABELONLY", nullptr, zero_sn, false),
		make_linux_disk_info(30, "sdb1", "DATA", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", data_sn, false),
		make_linux_disk_info(20, "sda1", "ROOT", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", preferred_sn, true)
	};
	disk_infos[0].sn_initialized = false;
	disk_infos[0].volume_id_initialized = false;

	sortLinuxDiskInfos(disk_infos);

	BOOST_REQUIRE_EQUAL(disk_infos.size(), 3U);
	BOOST_CHECK_EQUAL(string(disk_infos[0].device), "sda1");
	BOOST_CHECK(disk_infos[0].preferred);
	BOOST_CHECK_EQUAL(disk_infos[0].id, 0);
	BOOST_CHECK_EQUAL(string(disk_infos[1].device), "sdb1");
	BOOST_CHECK_EQUAL(disk_infos[1].id, 1);
	BOOST_CHECK_EQUAL(string(disk_infos[2].device), "zlabel");
	BOOST_CHECK_EQUAL(disk_infos[2].id, 2);
}

}  // namespace test
}  // namespace license
