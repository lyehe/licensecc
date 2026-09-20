#ifndef LICENSECC_BOUND_ENCODING_HPP_
#define LICENSECC_BOUND_ENCODING_HPP_
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>
namespace license {
namespace device_identity {
namespace bound_encoding {
bool hex_digest(const std::string&);
bool key_id_valid(const std::string&);
bool name(const std::string&, std::size_t maximum = 127);
bool utf8_text(const std::string&, std::size_t maximum = 1024);
bool safe_integer(const std::string&, std::uint64_t& out);
// Canonical loopback URI profile for the native pilot: explicit IP/port and
// unescaped ASCII path segments. Registration still pins the exact path.
bool loopback_uri(const std::string&);
bool uri_path(const std::string&);
std::string base64url(const std::string&);
std::string base64url(const std::uint8_t*, std::size_t);
bool token(std::string_view, std::size_t bytes);
// Bounded canonical decoder; does not change output on failure.
bool decode_base64url(const std::string&, std::size_t maximum_bytes, std::vector<std::uint8_t>&);
}  // namespace bound_encoding
}  // namespace device_identity
}  // namespace license
#endif
