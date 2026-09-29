package io.licensecc.client;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class Json {
    private Json() {}

    static Object parse(String text) {
        Parser parser = new Parser(text == null ? "" : text);
        Object value = parser.value();
        parser.whitespace();
        if (!parser.end()) {
            throw new IllegalArgumentException("trailing JSON content");
        }
        return value;
    }

    static String serialize(Object value) {
        StringBuilder output = new StringBuilder();
        write(output, value);
        return output.toString();
    }

    private static void write(StringBuilder output, Object value) {
        if (value == null) {
            output.append("null");
        } else if (value instanceof String string) {
            requireWellFormedUtf16(string);
            output.append('"');
            for (int index = 0; index < string.length(); index++) {
                char character = string.charAt(index);
                switch (character) {
                    case '"' -> output.append("\\\"");
                    case '\\' -> output.append("\\\\");
                    case '\b' -> output.append("\\b");
                    case '\f' -> output.append("\\f");
                    case '\n' -> output.append("\\n");
                    case '\r' -> output.append("\\r");
                    case '\t' -> output.append("\\t");
                    default -> {
                        if (character < 0x20) {
                            output.append(String.format("\\u%04x", (int) character));
                        } else {
                            output.append(character);
                        }
                    }
                }
            }
            output.append('"');
        } else if (value instanceof Boolean || value instanceof Byte || value instanceof Short
                || value instanceof Integer || value instanceof Long || value instanceof BigDecimal) {
            output.append(value);
        } else if (value instanceof Float floating) {
            requireFinite(floating.doubleValue());
            output.append(floating);
        } else if (value instanceof Double floating) {
            requireFinite(floating);
            output.append(floating);
        } else if (value instanceof Map<?, ?> map) {
            output.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!(entry.getKey() instanceof String key)) {
                    throw new IllegalArgumentException("JSON object keys must be strings");
                }
                if (!first) output.append(',');
                first = false;
                write(output, key);
                output.append(':');
                write(output, entry.getValue());
            }
            output.append('}');
        } else if (value instanceof Iterable<?> iterable) {
            output.append('[');
            boolean first = true;
            for (Object item : iterable) {
                if (!first) output.append(',');
                first = false;
                write(output, item);
            }
            output.append(']');
        } else {
            throw new IllegalArgumentException("unsupported JSON value: " + value.getClass().getName());
        }
    }

    private static void requireFinite(double value) {
        if (!Double.isFinite(value)) throw new IllegalArgumentException("JSON number must be finite");
    }

    private static final class Parser {
        private final String text;
        private int offset;

        private Parser(String text) { this.text = text; }

        private Object value() {
            whitespace();
            if (end()) throw new IllegalArgumentException("missing JSON value");
            return switch (text.charAt(offset)) {
                case '{' -> object();
                case '[' -> array();
                case '"' -> string();
                case 't' -> literal("true", Boolean.TRUE);
                case 'f' -> literal("false", Boolean.FALSE);
                case 'n' -> literal("null", null);
                default -> number();
            };
        }

        private Map<String, Object> object() {
            offset += 1;
            LinkedHashMap<String, Object> value = new LinkedHashMap<>();
            whitespace();
            if (take('}')) return value;
            while (true) {
                whitespace();
                if (end() || text.charAt(offset) != '"') throw new IllegalArgumentException("object key required");
                String key = string();
                if (value.containsKey(key)) throw new IllegalArgumentException("duplicate JSON object key");
                whitespace();
                require(':');
                value.put(key, value());
                whitespace();
                if (take('}')) return value;
                require(',');
            }
        }

        private List<Object> array() {
            offset += 1;
            ArrayList<Object> value = new ArrayList<>();
            whitespace();
            if (take(']')) return value;
            while (true) {
                value.add(value());
                whitespace();
                if (take(']')) return value;
                require(',');
            }
        }

        private String string() {
            require('"');
            StringBuilder value = new StringBuilder();
            while (!end()) {
                char character = text.charAt(offset++);
                if (character == '"') {
                    String decoded = value.toString();
                    requireWellFormedUtf16(decoded);
                    return decoded;
                }
                if (character < 0x20) throw new IllegalArgumentException("control character in JSON string");
                if (character != '\\') {
                    value.append(character);
                    continue;
                }
                if (end()) throw new IllegalArgumentException("truncated JSON escape");
                char escape = text.charAt(offset++);
                switch (escape) {
                    case '"', '\\', '/' -> value.append(escape);
                    case 'b' -> value.append('\b');
                    case 'f' -> value.append('\f');
                    case 'n' -> value.append('\n');
                    case 'r' -> value.append('\r');
                    case 't' -> value.append('\t');
                    case 'u' -> appendUnicode(value);
                    default -> throw new IllegalArgumentException("invalid JSON escape");
                }
            }
            throw new IllegalArgumentException("unterminated JSON string");
        }

        private void appendUnicode(StringBuilder value) {
            int first = hexQuad();
            char high = (char) first;
            if (Character.isHighSurrogate(high)) {
                if (offset + 2 > text.length() || text.charAt(offset) != '\\' || text.charAt(offset + 1) != 'u') {
                    throw new IllegalArgumentException("unpaired JSON surrogate");
                }
                offset += 2;
                char low = (char) hexQuad();
                if (!Character.isLowSurrogate(low)) throw new IllegalArgumentException("unpaired JSON surrogate");
                value.append(high).append(low);
            } else if (Character.isLowSurrogate(high)) {
                throw new IllegalArgumentException("unpaired JSON surrogate");
            } else {
                value.append(high);
            }
        }

        private int hexQuad() {
            if (offset + 4 > text.length()) throw new IllegalArgumentException("truncated JSON unicode escape");
            int value = 0;
            for (int index = 0; index < 4; index++) {
                int digit = Character.digit(text.charAt(offset++), 16);
                if (digit < 0) throw new IllegalArgumentException("invalid JSON unicode escape");
                value = (value << 4) | digit;
            }
            return value;
        }

        private BigDecimal number() {
            int start = offset;
            if (take('-') && end()) throw new IllegalArgumentException("invalid JSON number");
            if (take('0')) {
                if (!end() && Character.isDigit(text.charAt(offset))) throw new IllegalArgumentException("leading zero");
            } else {
                requireDigits();
            }
            if (take('.')) requireDigits();
            if (!end() && (text.charAt(offset) == 'e' || text.charAt(offset) == 'E')) {
                offset += 1;
                if (!end() && (text.charAt(offset) == '+' || text.charAt(offset) == '-')) offset += 1;
                requireDigits();
            }
            try {
                return new BigDecimal(text.substring(start, offset));
            } catch (NumberFormatException exception) {
                throw new IllegalArgumentException("invalid JSON number", exception);
            }
        }

        private void requireDigits() {
            int start = offset;
            while (!end() && Character.isDigit(text.charAt(offset))) offset += 1;
            if (offset == start) throw new IllegalArgumentException("invalid JSON number");
        }

        private Object literal(String token, Object value) {
            if (!text.startsWith(token, offset)) throw new IllegalArgumentException("invalid JSON literal");
            offset += token.length();
            return value;
        }

        private void require(char expected) {
            if (end() || text.charAt(offset++) != expected) throw new IllegalArgumentException("expected " + expected);
        }

        private boolean take(char expected) {
            if (!end() && text.charAt(offset) == expected) {
                offset += 1;
                return true;
            }
            return false;
        }

        private void whitespace() {
            while (!end()) {
                char character = text.charAt(offset);
                if (character != ' ' && character != '\n' && character != '\r' && character != '\t') return;
                offset += 1;
            }
        }

        private boolean end() { return offset == text.length(); }
    }

    private static void requireWellFormedUtf16(String value) {
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (Character.isHighSurrogate(character)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) {
                    throw new IllegalArgumentException("unpaired UTF-16 surrogate");
                }
                index += 1;
            } else if (Character.isLowSurrogate(character)) {
                throw new IllegalArgumentException("unpaired UTF-16 surrogate");
            }
        }
    }
}
