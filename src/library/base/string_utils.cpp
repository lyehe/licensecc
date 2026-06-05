/*
 * StringUtils.cpp
 *
 *  Created on: Apr 8, 2014
 *
 */

#include <cctype>  //toupper
#include <iostream>
#include <string>
#include <sstream>
#include <cstring>
#include <algorithm>
#include <stdexcept>
#include <regex>
#include "string_utils.h"

#ifdef _WIN32
#include <time.h>  //mktime under windows
#endif

namespace license {
using namespace std;

string trim_copy(const string &string_to_trim) {
	std::string::const_iterator it = string_to_trim.begin();
	while (it != string_to_trim.end() && isspace(static_cast<unsigned char>(*it))) {
		++it;
	}
	std::string::const_reverse_iterator rit = string_to_trim.rbegin();
	while (rit.base() != it && (isspace(static_cast<unsigned char>(*rit)) || *rit == 0)) {
		++rit;
	}
	return std::string(it, rit.base());
}

string toupper_copy(const string &lowercase) {
	string cp(lowercase);
	std::transform(cp.begin(), cp.end(), cp.begin(),
				   [](unsigned char ch) { return static_cast<char>(toupper(ch)); });
	return cp;
}

static bool parse_canonical_v200_date(const string &timeString, unsigned int &year, unsigned int &month,
									  unsigned int &day) {
	if (timeString.size() != 10 || timeString[4] != '-' || timeString[7] != '-') {
		return false;
	}
	auto parse_digits = [&timeString](const size_t offset, const size_t count, unsigned int &out) {
		out = 0;
		for (size_t i = offset; i < offset + count; ++i) {
			const unsigned char ch = static_cast<unsigned char>(timeString[i]);
			if (!isdigit(ch)) {
				return false;
			}
			out = out * 10 + static_cast<unsigned int>(ch - '0');
		}
		return true;
	};

	if (!parse_digits(0, 4, year) || !parse_digits(5, 2, month) || !parse_digits(8, 2, day)) {
		return false;
	}
	const bool leap_year = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
	const unsigned int days_in_month[] = {0,  31, leap_year ? 29U : 28U, 31, 30, 31, 30,
										  31, 31, 30,				 31, 30, 31};
	return year != 0 && month >= 1 && month <= 12 && day >= 1 && day <= days_in_month[month];
}

bool is_canonical_v200_date(const string &timeString) {
	unsigned int year = 0;
	unsigned int month = 0;
	unsigned int day = 0;
	return parse_canonical_v200_date(timeString, year, month, day);
}

time_t seconds_from_epoch(const string &timeString) {
	unsigned int year = 0;
	unsigned int month = 0;
	unsigned int day = 0;
	if (!parse_canonical_v200_date(timeString, year, month, day)) {
		throw invalid_argument("Date [" + timeString + "] is not a canonical YYYY-MM-DD calendar date");
	}
	tm tm_value = {};
	tm_value.tm_isdst = -1;
	tm_value.tm_year = static_cast<int>(year) - 1900;
	tm_value.tm_mon = static_cast<int>(month) - 1;
	tm_value.tm_mday = static_cast<int>(day);
	return mktime(&tm_value);
}

const vector<string> split_string(const string &licensePositions, char splitchar) {
	std::stringstream streamToSplit(licensePositions);
	std::string segment;
	std::vector<string> seglist;

	while (std::getline(streamToSplit, segment, splitchar)) {
		seglist.push_back(segment);
	}
	return seglist;
}

const static regex iniSection("\\[.*?\\]");
const static regex b64("^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$");

FILE_FORMAT identify_format(const string &license) {
	FILE_FORMAT result = UNKNOWN;
	string base64_candidate(license);
	base64_candidate.erase(std::remove(base64_candidate.begin(), base64_candidate.end(), '\n'), base64_candidate.end());
	base64_candidate.erase(std::remove(base64_candidate.begin(), base64_candidate.end(), '\r'), base64_candidate.end());
	if (regex_match(base64_candidate, b64)) {
		result = BASE64;
	} else if (regex_search(license, iniSection)) {
		result = INI;
	}
	return result;
}

// strnln_s is not well supported and strlen is marked unsafe..
size_t mstrnlen_s(const char *szptr, size_t maxsize) {
	if (szptr == nullptr) {
		return 0;
	}
	size_t count = 0;
	while (count < maxsize && szptr[count] != '\0') {
		++count;
	}
	return count;
}

size_t mstrlcpy(char *dst, const char *src, size_t n) {
	size_t n_orig = n;
	if (n > 0) {
		char *pd;
		const char *ps;

		for (--n, pd = dst, ps = src; n > 0 && *ps != '\0'; --n, ++pd, ++ps) *pd = *ps;

		*pd = '\0';
	}

	return n_orig - n;
}
} /* namespace license */
