#ifndef BASE64_H
#define BASE64_H

#include <cstdint>
#include <string>
#include <vector>

#if _WIN32
#include <wtypes.h>
#endif

namespace license {

std::vector<uint8_t> unbase64(const std::string& base64_data);
bool is_canonical_base64(const std::string& base64_data, bool allow_line_breaks = true);
std::string base64(const void* binaryData, size_t len, int lineLenght = -1);
/**
 * Decode base64 into a string of exactly the decoded bytes.
 * Returns an empty string when the input can not be decoded.
 */
std::string unbase64_to_string(const std::string& base64_data);

}  // namespace license

#endif
