using System;
using System.Text;

namespace Licensecc.Client
{
    /// <summary>Lowercase hex encode/decode helpers.</summary>
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

        private static int FromHexDigit(char c)
        {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        }
    }
}
