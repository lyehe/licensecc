/*
 * os-dependent.hpp
 *
 *  Created on: Mar 29, 2014
 *
 */

#ifndef OS_DEPENDENT_HPP_
#define OS_DEPENDENT_HPP_

#include <stddef.h>
#include <string.h>
#include <ctype.h>
#include <sys/types.h>
// definition of size_t
#include <stdlib.h>
#include <vector>
#ifdef __unix__
#include <unistd.h>
#include <stdbool.h>
#endif

#include <licensecc/datatypes.h>
#include "../base/base.h"

typedef enum {
	DISK_IDENTIFIER_SOURCE_NONE = 0,
	DISK_IDENTIFIER_SOURCE_SERIAL_OR_UUID = 1,
	DISK_IDENTIFIER_SOURCE_LABEL = 2,
	DISK_IDENTIFIER_SOURCE_MUTABLE_VOLUME = 3
} DISK_IDENTIFIER_SOURCE;

typedef struct {
	int id;
	char drive_root[MAX_PATH];
	bool drive_root_initialized;
	char device[MAX_PATH];
	unsigned char disk_sn[8];
	bool sn_initialized;
	char label[255];
	bool label_initialized;
	char filesystem[MAX_PATH];
	bool filesystem_initialized;
	char volume_id[MAX_PATH];
	bool volume_id_initialized;
	DISK_IDENTIFIER_SOURCE identifier_source;
	bool preferred;
} DiskInfo;

FUNCTION_RETURN getDiskInfos(std::vector<DiskInfo>& diskInfos);
#ifdef _WIN32
void appendWindowsDiskInfo(std::vector<DiskInfo>& diskInfos, const char* driveRoot, const char* volumeName,
						   const char* fileSystemName, unsigned long volumeSerial,
						   const char* volumeGuidPath = nullptr, const char* devicePath = nullptr);
void sortWindowsDiskInfos(std::vector<DiskInfo>& diskInfos);
#endif
FUNCTION_RETURN getUserHomePath(char[MAX_PATH]);
FUNCTION_RETURN getModuleName(char buffer[MAX_PATH]);
FUNCTION_RETURN getMachineName(unsigned char identifier[6]);
FUNCTION_RETURN getSecureRandomBytes(unsigned char* buffer, size_t size);
/**
 * Get an identifier of the machine in an os specific way.
 * In Linux it uses:
 * http://stackoverflow.com/questions/328936/getting-a-unique-id-from-a-unix-like-system
 *
 * <ul>
 * <li>Dbus if available</li>
 * </ul>
 * Can be used as a fallback in case no other methods are available.
 * Windows:
 * HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProductId
 * http://sowkot.blogspot.it/2008/08/generating-unique-keyfinger-print-for.html
 * http://stackoverflow.com/questions/2842116/reliable-way-of-generating-unique-hardware-id
 *
 *
 * @param identifier
 * @return
 */
FUNCTION_RETURN getOsSpecificIdentifier(unsigned char identifier[6]);


#ifdef _WIN32
#define SETENV(VAR, VAL) _putenv_s(VAR, VAL);
#define UNSETENV(P) _putenv_s(P, "");
#else
#define SETENV(VAR, VAL) setenv(VAR, VAL, 1);
#define UNSETENV(P) unsetenv(P);
#endif

#endif /* OS_DEPENDENT_HPP_ */
