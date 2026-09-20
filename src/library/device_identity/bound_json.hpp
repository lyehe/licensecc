#ifndef LICENSECC_BOUND_JSON_HPP_
#define LICENSECC_BOUND_JSON_HPP_
#include <cstdint>
#include <map>
#include <string>
namespace license {
namespace device_identity {
namespace bound_json {
struct Value {
	enum class Type { object, text, number, boolean } type = Type::object;
	std::map<std::string, Value> fields;
	std::string text;
	std::uint64_t number = 0;
	bool boolean = false;
};
// Protected response subset: object root, depth <=4, body <=16KiB, strict UTF-8,
// strings/booleans/unsigned safe integers. No arrays/null or duplicate keys.
// Output remains unchanged on failure. This parser establishes no authority.
bool parse(const std::string&, Value& out) noexcept;
}  // namespace bound_json
}  // namespace device_identity
}  // namespace license
#endif
