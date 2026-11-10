/*
 * LicenseReader.h
 *
 *  Created on: Mar 30, 2014
 *
 */

#ifndef LICENSEREADER_H_
#define LICENSEREADER_H_
#include <map>
#include <string>
#include <vector>

#include <licensecc/datatypes.h>

#include "base/EventRegistry.h"

namespace license {

class FullLicenseInfo {
public:
	const std::string license_signature;
	const std::string source;
	const std::string m_project;
	unsigned int m_magic;
	std::map<std::string, std::string> m_limits;

	FullLicenseInfo(const std::string& source, const std::string& product, const std::string& license_signature);
};

class LicenseReader {
private:
	const LicenseLocation* licenseLocation;

public:
	LicenseReader(const LicenseLocation* licenseLocation);
	EventRegistry readLicenses(const std::string& product, std::vector<FullLicenseInfo>& licenseInfoOut) const;
	virtual ~LicenseReader();
};
}  // namespace license
#endif /* LICENSEREADER_H_ */
