using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Licensecc.Client
{
    /// <summary>
    /// A tiny, zero-dependency JSON writer + reader sufficient for the licensing-backend's flat
    /// request/response bodies. The SDK deliberately avoids a JSON package dependency so the library
    /// restores with no network and stays usable on netstandard2.0 hosts without System.Text.Json.
    /// Only the subset the API uses is supported: objects with string / long / bool / null values,
    /// nested objects, and arrays (read side passes them through as List/Dictionary).
    /// </summary>
    internal static class Json
    {
        public static string Serialize(IReadOnlyDictionary<string, object?> obj)
        {
            var sb = new StringBuilder();
            WriteValue(sb, obj);
            return sb.ToString();
        }

        private static void WriteValue(StringBuilder sb, object? value)
        {
            switch (value)
            {
                case null:
                    sb.Append("null");
                    break;
                case string s:
                    WriteString(sb, s);
                    break;
                case bool b:
                    sb.Append(b ? "true" : "false");
                    break;
                case int i:
                    sb.Append(i.ToString(CultureInfo.InvariantCulture));
                    break;
                case long l:
                    sb.Append(l.ToString(CultureInfo.InvariantCulture));
                    break;
                case ulong ul:
                    sb.Append(ul.ToString(CultureInfo.InvariantCulture));
                    break;
                case double d:
                    sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
                    break;
                case IReadOnlyDictionary<string, object?> map:
                    WriteObject(sb, map);
                    break;
                case IEnumerable<object?> list:
                    WriteArray(sb, list);
                    break;
                default:
                    WriteString(sb, value.ToString() ?? string.Empty);
                    break;
            }
        }

        private static void WriteObject(StringBuilder sb, IReadOnlyDictionary<string, object?> map)
        {
            sb.Append('{');
            bool first = true;
            foreach (KeyValuePair<string, object?> kv in map)
            {
                if (!first)
                {
                    sb.Append(',');
                }

                first = false;
                WriteString(sb, kv.Key);
                sb.Append(':');
                WriteValue(sb, kv.Value);
            }

            sb.Append('}');
        }

        private static void WriteArray(StringBuilder sb, IEnumerable<object?> list)
        {
            sb.Append('[');
            bool first = true;
            foreach (object? item in list)
            {
                if (!first)
                {
                    sb.Append(',');
                }

                first = false;
                WriteValue(sb, item);
            }

            sb.Append(']');
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20)
                        {
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            sb.Append(c);
                        }

                        break;
                }
            }

            sb.Append('"');
        }

        // ---- Reader: returns Dictionary<string,object?> / List<object?> / string / double / bool / null ----

        public static object? Parse(string text)
        {
            int pos = 0;
            object? value = ParseValue(text, ref pos);
            SkipWhitespace(text, ref pos);
            if (pos != text.Length)
            {
                throw new FormatException("trailing characters after JSON value");
            }

            return value;
        }

        private static object? ParseValue(string text, ref int pos)
        {
            SkipWhitespace(text, ref pos);
            if (pos >= text.Length)
            {
                throw new FormatException("unexpected end of JSON");
            }

            char c = text[pos];
            switch (c)
            {
                case '{': return ParseObject(text, ref pos);
                case '[': return ParseArray(text, ref pos);
                case '"': return ParseString(text, ref pos);
                case 't':
                case 'f': return ParseBool(text, ref pos);
                case 'n': ParseLiteral(text, ref pos, "null"); return null;
                default: return ParseNumber(text, ref pos);
            }
        }

        private static Dictionary<string, object?> ParseObject(string text, ref int pos)
        {
            var result = new Dictionary<string, object?>();
            pos++; // {
            SkipWhitespace(text, ref pos);
            if (pos < text.Length && text[pos] == '}')
            {
                pos++;
                return result;
            }

            while (true)
            {
                SkipWhitespace(text, ref pos);
                string key = ParseString(text, ref pos);
                SkipWhitespace(text, ref pos);
                Expect(text, ref pos, ':');
                object? value = ParseValue(text, ref pos);
                result[key] = value;
                SkipWhitespace(text, ref pos);
                if (pos >= text.Length)
                {
                    throw new FormatException("unterminated object");
                }

                char c = text[pos++];
                if (c == '}')
                {
                    break;
                }

                if (c != ',')
                {
                    throw new FormatException("expected ',' or '}' in object");
                }
            }

            return result;
        }

        private static List<object?> ParseArray(string text, ref int pos)
        {
            var result = new List<object?>();
            pos++; // [
            SkipWhitespace(text, ref pos);
            if (pos < text.Length && text[pos] == ']')
            {
                pos++;
                return result;
            }

            while (true)
            {
                object? value = ParseValue(text, ref pos);
                result.Add(value);
                SkipWhitespace(text, ref pos);
                if (pos >= text.Length)
                {
                    throw new FormatException("unterminated array");
                }

                char c = text[pos++];
                if (c == ']')
                {
                    break;
                }

                if (c != ',')
                {
                    throw new FormatException("expected ',' or ']' in array");
                }
            }

            return result;
        }

        private static string ParseString(string text, ref int pos)
        {
            if (pos >= text.Length || text[pos] != '"')
            {
                throw new FormatException("expected string");
            }

            pos++; // opening quote
            var sb = new StringBuilder();
            while (pos < text.Length)
            {
                char c = text[pos++];
                if (c == '"')
                {
                    return sb.ToString();
                }

                if (c == '\\')
                {
                    if (pos >= text.Length)
                    {
                        throw new FormatException("unterminated escape");
                    }

                    char e = text[pos++];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (pos + 4 > text.Length)
                            {
                                throw new FormatException("bad unicode escape");
                            }

                            sb.Append((char)int.Parse(text.Substring(pos, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            pos += 4;
                            break;
                        default:
                            throw new FormatException("bad escape character");
                    }
                }
                else
                {
                    sb.Append(c);
                }
            }

            throw new FormatException("unterminated string");
        }

        private static bool ParseBool(string text, ref int pos)
        {
            if (text[pos] == 't')
            {
                ParseLiteral(text, ref pos, "true");
                return true;
            }

            ParseLiteral(text, ref pos, "false");
            return false;
        }

        private static double ParseNumber(string text, ref int pos)
        {
            int start = pos;
            while (pos < text.Length)
            {
                char c = text[pos];
                if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E')
                {
                    pos++;
                }
                else
                {
                    break;
                }
            }

            string slice = text.Substring(start, pos - start);
            if (slice.Length == 0)
            {
                throw new FormatException("expected number");
            }

            return double.Parse(slice, CultureInfo.InvariantCulture);
        }

        private static void ParseLiteral(string text, ref int pos, string literal)
        {
            if (pos + literal.Length > text.Length || text.Substring(pos, literal.Length) != literal)
            {
                throw new FormatException("expected literal " + literal);
            }

            pos += literal.Length;
        }

        private static void Expect(string text, ref int pos, char c)
        {
            if (pos >= text.Length || text[pos] != c)
            {
                throw new FormatException("expected '" + c + "'");
            }

            pos++;
        }

        private static void SkipWhitespace(string text, ref int pos)
        {
            while (pos < text.Length)
            {
                char c = text[pos];
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r')
                {
                    pos++;
                }
                else
                {
                    break;
                }
            }
        }
    }
}
