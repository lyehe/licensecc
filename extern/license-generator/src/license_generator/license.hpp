/*
 * License.hpp
 *
 *  Created on: Nov 10, 2019
 *      Author: GC
 */

#ifndef SRC_LICENSE_GENERATOR_LICENSE_HPP_
#define SRC_LICENSE_GENERATOR_LICENSE_HPP_
#include <boost/optional.hpp>
#include <map>
#include <string>
#include <iostream>

namespace license {
class License {
private:
	std::string m_private_key;
	std::string m_feature_names;
	unsigned int m_license_file_version;
	unsigned int m_target_license_format_max;

	const bool m_base64;
	const std::string *m_license_fname;
	const std::string m_project_folder;
	std::map<std::string, std::string> values_map;

	void print_as_ini(std::istream *previous_license, std::ostream &a_ostream) const;
	void set_license_file_version(const std::string &license_version);
	void set_target_license_format_max(const std::string &license_version);

public:
	License(const std::string *license_fname, const std::string &project_folder, bool base64 = false);
	void add_parameter(const std::string &param_name, const std::string &param_value);
	void set_allow_ip_binding(bool allow_ip_binding);
	void set_allow_env_selected_binding(bool allow_env_selected_binding);
	void set_allow_weak_disk_label_binding(bool allow_weak_disk_label_binding);
	void write_license();
	inline virtual ~License() {}

private:
	bool m_allow_ip_binding = false;
	bool m_allow_env_selected_binding = false;
	bool m_allow_weak_disk_label_binding = false;
};

} /* namespace license */

#endif /* SRC_LICENSE_GENERATOR_LICENSE_HPP_ */
