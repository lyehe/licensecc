#include "bound_json.hpp"
#include "bound_encoding.hpp"
#include <utility>
namespace license {
namespace device_identity {
namespace bound_json {
namespace {
class Parser {
	const std::string& source_;
	std::size_t offset_ = 0;
	void whitespace() {
		while (offset_ < source_.size() && (source_[offset_] == ' ' || source_[offset_] == '\t' ||
											source_[offset_] == '\r' || source_[offset_] == '\n'))
			++offset_;
	}
	bool take(char value) {
		whitespace();
		if (offset_ == source_.size() || source_[offset_] != value) return false;
		++offset_;
		return true;
	}
	bool hex(std::uint32_t& out) {
		if (source_.size() - offset_ < 4) return false;
		out = 0;
		for (unsigned i = 0; i < 4; ++i) {
			const char c = source_[offset_++];
			const unsigned value = c >= '0' && c <= '9'	  ? c - '0'
								   : c >= 'a' && c <= 'f' ? c - 'a' + 10
								   : c >= 'A' && c <= 'F' ? c - 'A' + 10
														  : 16;
			if (value == 16) return false;
			out = out * 16 + value;
		}
		return true;
	}
	bool unicode(std::string& out) {
		std::uint32_t point = 0;
		if (!hex(point)) return false;
		if (point >= 0xd800 && point <= 0xdbff) {
			if (source_.size() - offset_ < 6 || source_[offset_++] != '\\' || source_[offset_++] != 'u') return false;
			std::uint32_t low = 0;
			if (!hex(low) || low < 0xdc00 || low > 0xdfff) return false;
			point = 0x10000 + ((point - 0xd800) << 10) + low - 0xdc00;
		} else if (point >= 0xdc00 && point <= 0xdfff)
			return false;
		if (point < 0x80)
			out.push_back(static_cast<char>(point));
		else if (point < 0x800) {
			out.push_back(static_cast<char>(0xc0 | point >> 6));
			out.push_back(static_cast<char>(0x80 | (point & 63)));
		} else if (point < 0x10000) {
			out.push_back(static_cast<char>(0xe0 | point >> 12));
			out.push_back(static_cast<char>(0x80 | ((point >> 6) & 63)));
			out.push_back(static_cast<char>(0x80 | (point & 63)));
		} else {
			out.push_back(static_cast<char>(0xf0 | point >> 18));
			out.push_back(static_cast<char>(0x80 | ((point >> 12) & 63)));
			out.push_back(static_cast<char>(0x80 | ((point >> 6) & 63)));
			out.push_back(static_cast<char>(0x80 | (point & 63)));
		}
		return true;
	}
	bool string(std::string& out) {
		if (!take('"')) return false;
		while (offset_ < source_.size()) {
			const auto c = static_cast<unsigned char>(source_[offset_++]);
			if (c == '"') return true;
			if (c < 32) return false;
			if (c != '\\') {
				out.push_back(static_cast<char>(c));
				continue;
			}
			if (offset_ == source_.size()) return false;
			switch (source_[offset_++]) {
				case '"':
					out.push_back('"');
					break;
				case '\\':
					out.push_back('\\');
					break;
				case '/':
					out.push_back('/');
					break;
				case 'b':
					out.push_back('\b');
					break;
				case 'f':
					out.push_back('\f');
					break;
				case 'n':
					out.push_back('\n');
					break;
				case 'r':
					out.push_back('\r');
					break;
				case 't':
					out.push_back('\t');
					break;
				case 'u':
					if (!unicode(out)) return false;
					break;
				default:
					return false;
			}
		}
		return false;
	}
	bool value(Value& out, unsigned depth) {
		whitespace();
		if (offset_ == source_.size()) return false;
		if (source_[offset_] == '{') return object(out, depth);
		if (source_[offset_] == '"') {
			out.type = Value::Type::text;
			return string(out.text);
		}
		for (const auto* literal : {"true", "false"}) {
			const std::string word(literal);
			if (source_.compare(offset_, word.size(), word) == 0) {
				offset_ += word.size();
				out.type = Value::Type::boolean;
				out.boolean = word == "true";
				return true;
			}
		}
		const auto begin = offset_;
		while (offset_ < source_.size() && source_[offset_] >= '0' && source_[offset_] <= '9') ++offset_;
		out.type = Value::Type::number;
		return bound_encoding::safe_integer(source_.substr(begin, offset_ - begin), out.number);
	}
	bool object(Value& out, unsigned depth) {
		if (depth > 4 || !take('{')) return false;
		if (take('}')) return true;
		do {
			std::string key;
			Value item;
			if (!string(key) || key.size() > 1024 || !take(':') || !value(item, depth + 1) ||
				!out.fields.emplace(key, std::move(item)).second)
				return false;
			if (out.fields.size() > 32) return false;
			if (take('}')) return true;
		} while (take(','));
		return false;
	}

public:
	explicit Parser(const std::string& source) : source_(source) {}
	bool run(Value& out) {
		if (!object(out, 1)) return false;
		whitespace();
		return offset_ == source_.size();
	}
};
}  // namespace
bool parse(const std::string& source, Value& out) noexcept {
	try {
		if (!bound_encoding::utf8_text(source, 16384)) return false;
		Value candidate;
		Parser parser(source);
		if (!parser.run(candidate)) return false;
		out = std::move(candidate);
		return true;
	} catch (...) {
		return false;
	}
}
}  // namespace bound_json
}  // namespace device_identity
}  // namespace license
