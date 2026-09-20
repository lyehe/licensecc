#include "bound_encoding.hpp"
#include "p256_crypto.hpp"
#include <algorithm>
#include <charconv>

namespace license {
namespace device_identity {
namespace bound_encoding {
bool loopback_uri(const std::string& uri) {
	if (uri.size() > 1024) return false;
	std::size_t start = 0;
	if (uri.compare(0, 17, "http://127.0.0.1:") == 0)
		start = 17;
	else if (uri.compare(0, 13, "http://[::1]:") == 0)
		start = 13;
	else
		return false;
	const auto slash = uri.find('/', start);
	if (slash == std::string::npos) return false;
	std::uint64_t port = 0;
	if (!safe_integer(uri.substr(start, slash - start), port) || port == 0 || port == 80 || port > 65535) return false;
	return uri_path(uri.substr(slash));
}
bool uri_path(const std::string& path) {
	if (path.empty() || path.front() != '/' || path.size() > 1024) return false;
	for (const char c : path) {
		if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '/' || c == '-' ||
			  c == '_' || c == '.' || c == '~'))
			return false;
	}
	for (std::size_t segment = 1; segment < path.size();) {
		const auto end = path.find('/', segment);
		const auto part = path.substr(segment, end - segment);
		if (part == "." || part == "..") return false;
		if (end == std::string::npos) break;
		segment = end + 1;
	}
	return true;
}
bool hex_digest(const std::string& value) {
	return value.size() == 64 && std::all_of(value.begin(), value.end(), [](unsigned char c) {
			   return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
		   });
}
bool key_id_valid(const std::string& value) {
	return value.size() == 71 && value.compare(0, 7, "sha256:") == 0 && hex_digest(value.substr(7));
}
bool name(const std::string& value, std::size_t maximum) {
	return !value.empty() && value.size() <= maximum && std::all_of(value.begin(), value.end(), [](unsigned char c) {
		return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '.' ||
			   c == ':' || c == '-';
	});
}
// Reject overlong encodings, surrogate code points, truncated sequences and
// values above U+10FFFF, matching the domain encoder's UTF-8 round-trip rule.
bool utf8_text(const std::string& value, std::size_t maximum) {
	if (value.empty() || value.size() > maximum) return false;
	for (std::size_t i = 0; i < value.size();) {
		const auto first = static_cast<unsigned char>(value[i++]);
		if (first < 0x80) continue;
		unsigned count = 0, point = 0, minimum = 0;
		if (first >= 0xc2 && first <= 0xdf) {
			count = 1;
			point = first & 0x1f;
			minimum = 0x80;
		} else if (first >= 0xe0 && first <= 0xef) {
			count = 2;
			point = first & 0xf;
			minimum = 0x800;
		} else if (first >= 0xf0 && first <= 0xf4) {
			count = 3;
			point = first & 7;
			minimum = 0x10000;
		} else
			return false;
		if (value.size() - i < count) return false;
		while (count--) {
			const auto next = static_cast<unsigned char>(value[i++]);
			if ((next & 0xc0) != 0x80) return false;
			point = (point << 6) | (next & 0x3f);
		}
		if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return false;
	}
	return true;
}
bool safe_integer(const std::string& text, std::uint64_t& out) {
	if (text.empty() || (text.size() > 1 && text.front() == '0') ||
		!std::all_of(text.begin(), text.end(), [](unsigned char c) { return c >= '0' && c <= '9'; }))
		return false;
	std::uint64_t value = 0;
	const auto parsed = std::from_chars(text.data(), text.data() + text.size(), value);
	if (parsed.ec != std::errc() || parsed.ptr != text.data() + text.size() || value > 9007199254740991ULL)
		return false;
	out = value;
	return true;
}
std::string base64url(const std::string& value) {
	return base64url(reinterpret_cast<const std::uint8_t*>(value.data()), value.size());
}
std::string base64url(const std::uint8_t* value, std::size_t size) {
	auto encoded = encode_canonical_base64(value, size);
	std::replace(encoded.begin(), encoded.end(), '+', '-');
	std::replace(encoded.begin(), encoded.end(), '/', '_');
	while (!encoded.empty() && encoded.back() == '=') encoded.pop_back();
	return encoded;
}
bool token(std::string_view value, std::size_t bytes) {
	// The protected profile only defines 128-bit identifiers and 256-bit
	// secrets. Bound the arithmetic and reject unsupported widths first.
	if (bytes != 16 && bytes != 32) return false;
	if (value.size() != (bytes * 8 + 5) / 6 || !std::all_of(value.begin(), value.end(), [](unsigned char c) {
			return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
		}))
		return false;
	const char last = value.back();
	const unsigned digit = last >= 'A' && last <= 'Z'	? last - 'A'
						   : last >= 'a' && last <= 'z' ? last - 'a' + 26
						   : last >= '0' && last <= '9' ? last - '0' + 52
						   : last == '-'				? 62
														: 63;
	const unsigned padding_bits = static_cast<unsigned>(value.size() * 6 - bytes * 8);
	return (digit & ((1U << padding_bits) - 1U)) == 0;
}
bool decode_base64url(const std::string& value, std::size_t maximum_bytes, std::vector<std::uint8_t>& out) {
	if (maximum_bytes > 8192 || value.size() > (maximum_bytes * 4 + 2) / 3) return false;
	if (value.empty()) {
		std::vector<std::uint8_t> empty;
		out.swap(empty);
		return true;
	}
	if (!std::all_of(value.begin(), value.end(), [](unsigned char c) {
			return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
		}))
		return false;
	std::string padded = value;
	std::replace(padded.begin(), padded.end(), '-', '+');
	std::replace(padded.begin(), padded.end(), '_', '/');
	while (padded.size() % 4) padded.push_back('=');
	std::vector<std::uint8_t> candidate;
	if (!decode_canonical_base64(padded, candidate) || candidate.size() > maximum_bytes) return false;
	out.swap(candidate);
	return true;
}
}  // namespace bound_encoding
}  // namespace device_identity
}  // namespace license
