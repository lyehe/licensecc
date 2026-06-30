using System;
using System.Text;

namespace Licensecc.Client
{
    /// <summary>Lowercase hex encode/decode helpers and an ASCII-hex predicate matching the C++
    /// verifier's <c>is_ascii_hex</c> (which uses <c>std::isxdigit</c>, i.e. both cases accepted).</summary>
    internal static class Hex
    {
        public static byte[] Decode(string hex)
        {
            if (hex == null)
            {
                throw new ArgumentNullException(nameof(hex));
            }

            string trimmed = hex.Trim();
            if ((trimmed.Length & 1) != 0)
            {
                throw new FormatException("hex string has odd length");
            }

            byte[] result = new byte[trimmed.Length / 2];
            for (int i = 0; i < result.Length; i++)
            {
                int hi = FromHexDigit(trimmed[2 * i]);
                int lo = FromHexDigit(trimmed[2 * i + 1]);
                if (hi < 0 || lo < 0)
                {
                    throw new FormatException("hex string contains a non-hex character");
                }

                result[i] = (byte)((hi << 4) | lo);
            }

            return result;
        }

        public static string Encode(byte[] data)
        {
            var sb = new StringBuilder(data.Length * 2);
            foreach (byte b in data)
            {
                sb.Append("0123456789abcdef"[b >> 4]);
                sb.Append("0123456789abcdef"[b & 0xF]);
            }

            return sb.ToString();
        }

        /// <summary>True when <paramref name="value"/> is exactly <paramref name="expectedLength"/>
        /// ASCII hex digits (upper or lower case), matching <c>is_ascii_hex(value, expected_size)</c>.</summary>
        public static bool IsAsciiHex(string value, int expectedLength)
        {
            if (value == null || value.Length != expectedLength)
            {
                return false;
            }

            foreach (char c in value)
            {
                if (FromHexDigit(c) < 0)
                {
                    return false;
                }
            }

            return true;
        }

        private static int FromHexDigit(char c)
        {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        }
    }
}
