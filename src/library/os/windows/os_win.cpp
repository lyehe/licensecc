#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <algorithm>
#include <cctype>
#include <cstring>
#include <limits>
#include <licensecc/datatypes.h>
#include <iphlpapi.h>
#include <stdio.h>

#include "../../base/string_utils.h"
#include "../../base/logger.h"
#include "../os.h"
using namespace std;

FUNCTION_RETURN getMachineName(unsigned char identifier[6]) {
	FUNCTION_RETURN result = FUNC_RET_ERROR;
	char buffer[MAX_COMPUTERNAME_LENGTH + 1];
	int bufsize = MAX_COMPUTERNAME_LENGTH + 1;
	const BOOL cmpName = GetComputerName(buffer, (unsigned long*)&bufsize);
	if (cmpName) {
		strncpy((char*)identifier, buffer, 6);
		result = FUNC_RET_OK;
	}
	return result;
}

FUNCTION_RETURN getSecureRandomBytes(unsigned char* buffer, size_t size) {
	if (size == 0) {
		return FUNC_RET_OK;
	}
	if (buffer == nullptr || size > static_cast<size_t>(std::numeric_limits<ULONG>::max())) {
		return FUNC_RET_ERROR;
	}
	const NTSTATUS status = BCryptGenRandom(nullptr, buffer, static_cast<ULONG>(size),
											BCRYPT_USE_SYSTEM_PREFERRED_RNG);
	return status == 0 ? FUNC_RET_OK : FUNC_RET_ERROR;
}

// http://www.ok-soft-gmbh.com/ForStackOverflow/EnumMassStorage.c
// http://stackoverflow.com/questions/3098696/same-code-returns-diffrent-result-on-windows7-32-bit-system
#define MAX_UNITS 40

static bool disk_info_less(const DiskInfo& lhs, const DiskInfo& rhs) {
	if (lhs.preferred != rhs.preferred) {
		return lhs.preferred && !rhs.preferred;
	}
	const char* lhs_root = lhs.drive_root_initialized ? lhs.drive_root : lhs.device;
	const char* rhs_root = rhs.drive_root_initialized ? rhs.drive_root : rhs.device;
	const int root_cmp = strcmp(lhs_root, rhs_root);
	if (root_cmp != 0) {
		return root_cmp < 0;
	}
	const int device_cmp = strcmp(lhs.device, rhs.device);
	if (device_cmp != 0) {
		return device_cmp < 0;
	}
	return strcmp(lhs.label, rhs.label) < 0;
}

void sortWindowsDiskInfos(std::vector<DiskInfo>& diskInfos) {
	sort(diskInfos.begin(), diskInfos.end(), disk_info_less);
	for (size_t i = 0; i < diskInfos.size(); ++i) {
		diskInfos[i].id = static_cast<int>(i);
	}
}

static int hex_value(const char ch) {
	if (ch >= '0' && ch <= '9') {
		return ch - '0';
	}
	const char lower = static_cast<char>(tolower(static_cast<unsigned char>(ch)));
	if (lower >= 'a' && lower <= 'f') {
		return 10 + lower - 'a';
	}
	return -1;
}

static bool derive_identifier_from_volume_guid(const char* volumeGuidPath, unsigned char out[8]) {
	if (volumeGuidPath == nullptr || volumeGuidPath[0] == '\0') {
		return false;
	}
	memset(out, 0, 8);
	int high_nibble = -1;
	size_t byte_index = 0;
	size_t hex_digits = 0;
	for (const char* cursor = volumeGuidPath; *cursor != '\0'; ++cursor) {
		const int value = hex_value(*cursor);
		if (value < 0) {
			continue;
		}
		++hex_digits;
		if (high_nibble < 0) {
			high_nibble = value;
			continue;
		}
		out[byte_index % 8] = static_cast<unsigned char>(out[byte_index % 8] ^ ((high_nibble << 4) | value));
		++byte_index;
		high_nibble = -1;
	}
	if (high_nibble >= 0) {
		out[byte_index % 8] = static_cast<unsigned char>(out[byte_index % 8] ^ (high_nibble << 4));
	}
	return hex_digits > 0;
}

void appendWindowsDiskInfo(std::vector<DiskInfo>& diskInfos, const char* driveRoot, const char* volumeName,
						   const char* fileSystemName, unsigned long volumeSerial, const char* volumeGuidPath,
						   const char* devicePath) {
	DiskInfo diskInfo = {};
	diskInfo.id = static_cast<int>(diskInfos.size());
	if (driveRoot != nullptr && driveRoot[0] != '\0') {
		license::mstrlcpy(diskInfo.drive_root, driveRoot, sizeof(diskInfo.drive_root));
		diskInfo.drive_root_initialized = true;
	}
	if (devicePath != nullptr && devicePath[0] != '\0') {
		license::mstrlcpy(diskInfo.device, devicePath, sizeof(diskInfo.device));
	}
	if (volumeName != nullptr && volumeName[0] != '\0') {
		license::mstrlcpy(diskInfo.label, volumeName, sizeof(diskInfo.label));
		diskInfo.label_initialized = true;
	}
	if (fileSystemName != nullptr && fileSystemName[0] != '\0') {
		license::mstrlcpy(diskInfo.filesystem, fileSystemName, sizeof(diskInfo.filesystem));
		diskInfo.filesystem_initialized = true;
	}
	if (volumeGuidPath != nullptr && volumeGuidPath[0] != '\0') {
		license::mstrlcpy(diskInfo.volume_id, volumeGuidPath, sizeof(diskInfo.volume_id));
		diskInfo.volume_id_initialized = true;
	}
	if (derive_identifier_from_volume_guid(volumeGuidPath, diskInfo.disk_sn)) {
		diskInfo.identifier_source = DISK_IDENTIFIER_SOURCE_SERIAL_OR_UUID;
		diskInfo.sn_initialized = true;
	} else if (volumeSerial != 0) {
		memcpy(diskInfo.disk_sn, &volumeSerial, std::min(sizeof(diskInfo.disk_sn), sizeof(volumeSerial)));
		diskInfo.identifier_source = DISK_IDENTIFIER_SOURCE_MUTABLE_VOLUME;
		diskInfo.sn_initialized = true;
	}
	diskInfo.preferred = driveRoot != nullptr && toupper(static_cast<unsigned char>(driveRoot[0])) == 'C';
	diskInfos.push_back(diskInfo);
}

// bug check return with diskinfos == null func_ret_ok
FUNCTION_RETURN getDiskInfos(std::vector<DiskInfo>& diskInfos) {
	DWORD fileMaxLen;
	size_t drives_scanned = 0;
	DWORD fileFlags;
	char volName[MAX_PATH];
	DWORD volSerial = 0;
	const DWORD dwSize = MAX_PATH;
	char szLogicalDrives[MAX_PATH] = {0};

	FUNCTION_RETURN return_value;
	const DWORD dwResult = GetLogicalDriveStrings(dwSize, szLogicalDrives);

	if (dwResult > 0) {
		return_value = FUNC_RET_OK;
		char* szSingleDrive = szLogicalDrives;
		while (*szSingleDrive && drives_scanned < MAX_UNITS) {
			// get the next drive
			UINT driveType = GetDriveType(szSingleDrive);
			if (driveType == DRIVE_FIXED) {
				char fileSysName[MAX_PATH];
				BOOL success = GetVolumeInformation(szSingleDrive, volName, MAX_PATH, &volSerial, &fileMaxLen,
													&fileFlags, fileSysName, MAX_PATH);
				if (success) {
					char volumeGuidPath[MAX_PATH] = {0};
					BOOL volume_name_success = GetVolumeNameForVolumeMountPointA(szSingleDrive, volumeGuidPath, MAX_PATH);
					char driveName[3] = {szSingleDrive[0], ':', '\0'};
					char devicePath[MAX_PATH] = {0};
					BOOL device_name_success = QueryDosDeviceA(driveName, devicePath, MAX_PATH);
					LOG_DEBUG("drive: %s,volume Name: %s, Volume Serial: 0x%x,Filesystem: %s", szSingleDrive, volName,
							  volSerial, fileSysName);
					if (!volume_name_success) {
						LOG_DEBUG("Unable to retrieve volume GUID path of '%s'", szSingleDrive);
					}
					if (!device_name_success) {
						LOG_DEBUG("Unable to retrieve device path of '%s'", szSingleDrive);
					}
					appendWindowsDiskInfo(diskInfos, szSingleDrive, volName, fileSysName, volSerial,
										  volume_name_success ? volumeGuidPath : nullptr,
										  device_name_success ? devicePath : nullptr);
				} else {
					LOG_DEBUG("Unable to retrieve information of '%s'", szSingleDrive);
				}
			} else {
				LOG_DEBUG("This volume is not fixed : %s, type: %d", szSingleDrive);
			}
			szSingleDrive += strlen(szSingleDrive) + 1;
			drives_scanned++;
		}
	}
	if (diskInfos.size() > 0) {
		sortWindowsDiskInfos(diskInfos);
		return_value = FUNC_RET_OK;
	} else {
		return_value = FUNC_RET_NOT_AVAIL;
		LOG_DEBUG("No fixed drive were detected");
	}

	return return_value;
}

FUNCTION_RETURN getModuleName(char buffer[MAX_PATH]) {
	FUNCTION_RETURN result = FUNC_RET_OK;
	const DWORD wres = GetModuleFileName(NULL, buffer, MAX_PATH);
	if (wres == 0) {
		result = FUNC_RET_ERROR;
	}
	return result;
}
