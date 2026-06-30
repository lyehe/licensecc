using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;

namespace Licensecc.Client
{
    /// <summary>
    /// Shared signed-token primitives mirroring <c>src/library/signed_token/SignedToken.cpp</c>:
    /// envelope split with canonical-base64 enforcement, RSA-PKCS1-SHA256 verification against a
    /// key-id-selected trusted key, the canonical ordered field parser, and the key-id digest.
    /// Every helper is fail-closed: malformed input is rejected, never thrown to the caller.
    /// </summary>
    internal static class SignedTokenCore
    {
        public const string AlgorithmRsaPkcs1Sha256 = "rsa-pkcs1-sha256";

        /// <summary>The C++ verifiers enforce a 3072-bit RSA floor on every signed-token path.</summary>
        public const int MinPublicKeyBits = 3072;

        private const int FutureSkewSeconds = 300;

        /// <summary>
        /// One canonical payload field: a key and the destination slot the parsed value is written into.
        /// </summary>
        public sealed class FieldSpec
        {
            public FieldSpec(string key, Action<string> assign)
            {
                Key = key;
                Assign = assign;
            }

            public string Key { get; }
            public Action<string> Assign { get; }
        }

        /// <summary>Future-skew used by both verifiers when validating issued-at.</summary>
        public static int IssuedAtFutureSkewSeconds => FutureSkewSeconds;

        /// <summary>Canonical <c>sha256:&lt;64-hex&gt;</c> over DER bytes (C++ <c>public_key_id_from_der</c>).</summary>
        public static string KeyIdFromDer(byte[] der)
        {
            using (SHA256 sha = SHA256.Create())
            {
                return "sha256:" + Hex.Encode(sha.ComputeHash(der));
            }
        }

        /// <summary>
        /// Returns true only when <paramref name="value"/> is exactly the standard base64 (RFC 4648,
        /// '+'/'/' alphabet, padded) re-encoding of its own decoded bytes — the same round-trip
        /// equality test as C++ <c>is_canonical_base64(value, allow_line_breaks=false)</c>. Rejects
        /// url-safe alphabets, whitespace, missing/extra padding, and non-minimal encodings.
        /// </summary>
        public static bool TryDecodeCanonicalBase64(string value, out byte[] decoded)
        {
            decoded = new byte[0];
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }

            // No line breaks / whitespace allowed (allow_line_breaks=false in the C++ split path).
            foreach (char c in value)
            {
                if (c == '\n' || c == '\r' || c == ' ' || c == '\t')
                {
                    return false;
                }
                bool inAlphabet = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                                  (c >= '0' && c <= '9') || c == '+' || c == '/' || c == '=';
                if (!inAlphabet)
                {
                    return false;
                }
            }

            byte[] bytes;
            try
            {
                bytes = Convert.FromBase64String(value);
            }
            catch (FormatException)
            {
                return false;
            }

            if (bytes.Length == 0)
            {
                return false;
            }

            // Canonicality: the value must equal the standard base64 re-encoding of its bytes. This
            // rejects non-minimal padding bits and any alternate spelling that .NET would tolerate.
            if (Convert.ToBase64String(bytes) != value)
            {
                return false;
            }

            decoded = bytes;
            return true;
        }

        /// <summary>
        /// Split <c>prefix.&lt;payload-b64&gt;.&lt;sig-b64&gt;</c> into decoded payload/signature bytes.
        /// Enforces exactly two dots, the exact prefix, and canonical base64 for both parts.
        /// </summary>
        public static bool TrySplitEnvelope(string token, string expectedPrefix,
            out byte[] payload, out byte[] signature, out string error)
        {
            payload = new byte[0];
            signature = new byte[0];
            error = string.Empty;

            if (token == null)
            {
                error = "token is null";
                return false;
            }

            int firstDot = token.IndexOf('.');
            if (firstDot < 0)
            {
                error = "envelope missing payload";
                return false;
            }

            int secondDot = token.IndexOf('.', firstDot + 1);
            if (secondDot < 0 || token.IndexOf('.', secondDot + 1) >= 0)
            {
                error = "envelope malformed";
                return false;
            }

            string prefix = token.Substring(0, firstDot);
            if (!StringEquals(prefix, expectedPrefix))
            {
                error = "envelope prefix mismatch";
                return false;
            }

            string payloadB64 = token.Substring(firstDot + 1, secondDot - firstDot - 1);
            string signatureB64 = token.Substring(secondDot + 1);

            if (!TryDecodeCanonicalBase64(payloadB64, out payload) ||
                !TryDecodeCanonicalBase64(signatureB64, out signature))
            {
                error = "envelope base64 is not canonical";
                return false;
            }

            if (payload.Length == 0 || signature.Length == 0)
            {
                error = "decoded payload or signature is empty";
                return false;
            }

            return true;
        }

        /// <summary>
        /// Verify the RSA-PKCS1-SHA256 signature over <paramref name="payload"/> using the trusted key
        /// selected by the <c>key-id</c> field embedded in the payload. Mirrors
        /// <c>verify_payload_signature</c> + <c>signature_request_allowed</c>: requires alg ==
        /// rsa-pkcs1-sha256, a known key-id, a key-id that matches its DER digest, and a >= 3072-bit key.
        /// </summary>
        public static bool TryVerifySignature(byte[] payload, byte[] signature, string payloadText,
            TrustedKeyRing keyRing, out string error)
        {
            error = string.Empty;

            if (!ExtractPreverifyField(payloadText, "alg", out string algorithm) ||
                !ExtractPreverifyField(payloadText, "key-id", out string keyId))
            {
                error = "missing signature metadata";
                return false;
            }

            if (algorithm != AlgorithmRsaPkcs1Sha256)
            {
                error = "unsupported signature algorithm";
                return false;
            }

            if (!keyRing.TryGet(keyId, out TrustedPublicKey? key) || key == null)
            {
                error = "unknown key-id";
                return false;
            }

            // The trusted record must be self-consistent: key-id == sha256 over its DER bytes.
            if (!StringEquals(key.KeyId, KeyIdFromDer(key.PublicKeyDer)))
            {
                error = "trusted key-id does not match its DER";
                return false;
            }

            using (var rsa = RSA.Create())
            {
                try
                {
                    // PKCS#1 RSAPublicKey DER is consumed natively by .NET; no SPKI wrapping needed.
                    rsa.ImportRSAPublicKey(key.PublicKeyDer, out _);
                }
                catch (CryptographicException)
                {
                    error = "trusted public key is not importable";
                    return false;
                }

                if (rsa.KeySize < MinPublicKeyBits)
                {
                    error = "public key below the 3072-bit floor";
                    return false;
                }

                bool ok = rsa.VerifyData(payload, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
                if (!ok)
                {
                    error = "signature verification failed";
                    return false;
                }
            }

            return true;
        }

        /// <summary>
        /// Parse the canonical payload: every field must appear in <paramref name="fields"/> order, each
        /// line is <c>key=value</c>, the payload must end with a single trailing newline and contain no
        /// extra fields. When <paramref name="validateValues"/> is true, a value may not contain '=' or
        /// CR/LF (matching <c>parse_fields_in_order(..., validate_values=true)</c>).
        /// </summary>
        public static bool TryParseCanonicalPayload(string payloadText, FieldSpec[] fields,
            bool validateValues, out string error)
        {
            error = string.Empty;

            if (payloadText.Length == 0 || payloadText[payloadText.Length - 1] != '\n' ||
                payloadText.IndexOf('\r') >= 0)
            {
                error = "payload is not canonical";
                return false;
            }

            int pos = 0;
            foreach (FieldSpec field in fields)
            {
                int next = payloadText.IndexOf('\n', pos);
                if (next < 0)
                {
                    error = "missing field " + field.Key;
                    return false;
                }

                string line = payloadText.Substring(pos, next - pos);
                string prefix = field.Key + "=";
                if (!line.StartsWith(prefix, StringComparison.Ordinal))
                {
                    error = "expected field " + field.Key;
                    return false;
                }

                string value = line.Substring(prefix.Length);
                if (validateValues && (value.IndexOf('=') >= 0 || value.IndexOf('\n') >= 0 || value.IndexOf('\r') >= 0))
                {
                    error = "invalid value for " + field.Key;
                    return false;
                }

                field.Assign(value);
                pos = next + 1;
            }

            if (pos != payloadText.Length)
            {
                error = "payload has unknown trailing fields";
                return false;
            }

            return true;
        }

        /// <summary>Parse a non-empty base-10 unsigned 64-bit integer, rejecting any non-digit
        /// (mirrors C++ <c>parse_uint64</c>: empty -&gt; false, any non '0'-'9' -&gt; false).</summary>
        public static bool TryParseUInt64(string value, out ulong result)
        {
            result = 0;
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }

            ulong acc = 0;
            foreach (char c in value)
            {
                if (c < '0' || c > '9')
                {
                    return false;
                }

                ulong digit = (ulong)(c - '0');
                if (acc > (ulong.MaxValue - digit) / 10UL)
                {
                    return false;
                }

                acc = acc * 10UL + digit;
            }

            result = acc;
            return true;
        }

        /// <summary>Find a <c>key=value</c> field by scanning newline-delimited lines, before the full
        /// ordered parse (used only to pull alg/key-id for signature verification).</summary>
        private static bool ExtractPreverifyField(string payload, string key, out string value)
        {
            value = string.Empty;
            string prefix = key + "=";
            int pos = 0;
            while (pos < payload.Length)
            {
                int next = payload.IndexOf('\n', pos);
                if (next < 0)
                {
                    return false;
                }

                string line = payload.Substring(pos, next - pos);
                if (line.StartsWith(prefix, StringComparison.Ordinal))
                {
                    value = line.Substring(prefix.Length);
                    return value.Length > 0;
                }

                pos = next + 1;
            }

            return false;
        }

        /// <summary>Build a payload string from ordered claim lines (used by tests to craft tampered
        /// payloads and to round-trip claims). Each line is <c>key=value\n</c>.</summary>
        public static string BuildCanonicalPayload(IEnumerable<KeyValuePair<string, string>> lines)
        {
            var sb = new StringBuilder();
            foreach (KeyValuePair<string, string> line in lines)
            {
                sb.Append(line.Key).Append('=').Append(line.Value).Append('\n');
            }

            return sb.ToString();
        }

        /// <summary>Ordinal string equality (no culture surprises in security comparisons).</summary>
        public static bool StringEquals(string a, string b) => string.Equals(a, b, StringComparison.Ordinal);

        /// <summary>UTF-8 encode (payloads are UTF-8 of the canonical key=value lines).</summary>
        public static byte[] Utf8(string text) => Encoding.UTF8.GetBytes(text);
    }
}
