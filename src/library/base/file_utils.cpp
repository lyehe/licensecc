/*
 * FileUtils.cpp
 *
 *  Created on: Oct 8, 2019
 *      Author: devel
 */

#include <fstream>
#include <string>
#include <cstdint>
#include <cerrno>
#include <iostream>
#include <algorithm>
#include <errno.h>
#include <cstring>
#include "file_utils.hpp"

namespace license {
using namespace std;

vector<string> filter_existing_files(const vector<string> &fileList, EventRegistry& registry, const char* extraData,
									 size_t max_size) {
	vector<string> existingFiles;
	for (auto it = fileList.begin(); it != fileList.end(); it++) {
		registry.addEvent(LICENSE_SPECIFIED,it->c_str(), extraData);
		ifstream f(it->c_str(), ios::binary | ios::ate);
		if (f.good()) {
			const streampos file_size = f.tellg();
			if (max_size > 0 && file_size >= 0 && static_cast<uintmax_t>(file_size) > max_size) {
				registry.addEvent(LICENSE_MALFORMED, it->c_str(), "license file exceeds maximum size");
				f.close();
				continue;
			}
			existingFiles.push_back(*it);
			registry.addEvent(LICENSE_FOUND,it->c_str(),extraData);
		} else {
			registry.addEvent(LICENSE_FILE_NOT_FOUND,it->c_str(), extraData);
		}
		f.close();
	}
	return existingFiles;
}

string get_file_contents(const char *filename, size_t max_size) {
	string contents;
	ifstream in(filename, std::ios::binary);
	if (in) {
		const std::streamoff end_pos = in.seekg(0, ios::end).tellg();
		// A negative tellg() (non-seekable or special file) must not be cast to a
		// huge size_t; bound to max_size, then truncate to the bytes actually read
		// so a short/special read never returns a zero-filled garbage tail.
		size_t limited_size = max_size;
		if (end_pos >= 0) {
			limited_size = min(static_cast<size_t>(end_pos), max_size);
		}
		contents.resize(limited_size);
		in.seekg(0, ios::beg);
		in.read(&contents[0], limited_size);
		contents.resize(static_cast<size_t>(in.gcount()));
		in.close();
	} else {
		throw runtime_error(std::strerror(errno));
	}
	return contents;
}

string remove_extension(const string& path) {
	if (path == "." || path == "..") {
		return path;
	}
	size_t dotpos = path.find_last_of(".");
	//no dot
	if (dotpos == string::npos) {
		return path;
	}
	//find the last path separator
	size_t pathsep_pos = path.find_last_of("\\/");
	if (pathsep_pos == string::npos) {
		return (dotpos == 0 ? path : path.substr(0, dotpos));
	} else if(pathsep_pos >= dotpos +1) {
		return path;
	}
	return path.substr(0, dotpos);
}

}
