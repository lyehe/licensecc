using System.Collections.Generic;
using System.Security.Cryptography;

namespace Licensecc.Client
{
    /// <summary>The parsed claims of an <c>lcccfg1.</c> config-attestation token, in canonical order.</summary>
    public sealed class ConfigTokenClaims
    {
        public string Purpose { get; internal set; } = string.Empty;
        public string Version { get; internal set; } = string.Empty;
        public string Algorithm { get; internal set; } = string.Empty;
        public string KeyId { get; internal set; } = string.Empty;
        public string Project { get; internal set; } = string.Empty;
        public string Feature { get; internal set; } = string.Empty;
        public string LicenseFingerprint { get; internal set; } = string.Empty;
        public string DeviceHash { get; internal set; } = string.Empty;
        public string ConfigId { get; internal set; } = string.Empty;
        public ulong ConfigSeq { get; internal set; }
        public string ConfigHash { get; internal set; } = string.Empty;
        public ulong IssuedAt { get; internal set; }
        public ulong ExpiresAt { get; internal set; }
    }

    /// <summary>Caller-supplied expectations for a config token. Mirrors <c>ConfigAttestationExpected</c>.</summary>
    public sealed class ConfigTokenExpected
    {
        /// <summary>Expected <c>project</c> binding.</summary>
        public string Project { get; set; } = string.Empty;

        /// <summary>Expected <c>feature</c> binding.</summary>
        public string Feature { get; set; } = string.Empty;

        /// <summary>Expected <c>license-fingerprint</c> binding.</summary>
        public string LicenseFingerprint { get; set; } = string.Empty;

        /// <summary>Expected <c>device-hash</c> binding (empty for no device binding).</summary>
        public string DeviceHash { get; set; } = string.Empty;

        /// <summary>The raw config bytes the token must attest to. <c>config-hash</c> must equal
        /// <c>sha256:&lt;hex&gt;</c> over these bytes.</summary>
        public byte[] ConfigBytes { get; set; } = new byte[0];

        /// <summary>Anti-rollback floor: the token's <c>config-seq</c> must be &gt;= this value.</summary>
        public ulong MinConfigSeq { get; set; }

        /// <summary>The reference "now" in Unix seconds. 0 means "use the system clock".</summary>
        public ulong NowEpochSeconds { get; set; }

        /// <summary>Trusted key ring the signature is verified against. Required.</summary>
        public TrustedKeyRing? TrustedKeys { get; set; }
    }

    /// <summary>
    /// Offline verifier for the <c>lcccfg1.</c> config-attestation token. Same envelope/signature core
    /// as the online assertion, with the config-attestation purpose, the config-hash binding, and the
    /// "must carry a finite expiry" rule. Mirrors <c>src/library/config_attestation/ConfigAttestation.cpp</c>.
    /// </summary>
    public static class ConfigTokenVerifier
    {
        public const string EnvelopePrefix = "lcccfg1";
        public const string Purpose = "licensecc-config-attestation";
        public const string Version = "1";

        /// <summary>Verify and validate a config token against <paramref name="expected"/>. Never throws.</summary>
        public static VerifyResult<ConfigTokenClaims> Verify(string token, ConfigTokenExpected expected)
        {
            if (expected == null || expected.TrustedKeys == null)
            {
                return VerifyResult<ConfigTokenClaims>.Failure(
                    VerifyFailureCode.Signature, "no trusted keys configured");
            }

            if (!SignedTokenCore.TrySplitEnvelope(token, EnvelopePrefix, out byte[] payload,
                    out byte[] signature, out string envelopeError))
            {
                return VerifyResult<ConfigTokenClaims>.Failure(VerifyFailureCode.Envelope, envelopeError);
            }

            string payloadText = System.Text.Encoding.UTF8.GetString(payload);

            if (!SignedTokenCore.TryVerifySignature(payload, signature, payloadText, expected.TrustedKeys,
                    out string signatureError))
            {
                return VerifyResult<ConfigTokenClaims>.Failure(VerifyFailureCode.Signature, signatureError);
            }

            if (!TryParseClaims(payloadText, out ConfigTokenClaims claims, out string parseError))
            {
                return VerifyResult<ConfigTokenClaims>.Failure(VerifyFailureCode.Payload, parseError);
            }

            VerifyFailureCode validateCode = ValidateClaims(claims, expected, out string validateError);
            if (validateCode != VerifyFailureCode.None)
            {
                return VerifyResult<ConfigTokenClaims>.Failure(validateCode, validateError);
            }

            return VerifyResult<ConfigTokenClaims>.Success(claims);
        }

        private static bool TryParseClaims(string payloadText, out ConfigTokenClaims claims, out string error)
        {
            claims = new ConfigTokenClaims();
            ConfigTokenClaims c = claims;
            string configSeq = string.Empty, issuedAt = string.Empty, expiresAt = string.Empty;

            var fields = new[]
            {
                new SignedTokenCore.FieldSpec("purpose", v => c.Purpose = v),
                new SignedTokenCore.FieldSpec("version", v => c.Version = v),
                new SignedTokenCore.FieldSpec("alg", v => c.Algorithm = v),
                new SignedTokenCore.FieldSpec("key-id", v => c.KeyId = v),
                new SignedTokenCore.FieldSpec("project", v => c.Project = v),
                new SignedTokenCore.FieldSpec("feature", v => c.Feature = v),
                new SignedTokenCore.FieldSpec("license-fingerprint", v => c.LicenseFingerprint = v),
                new SignedTokenCore.FieldSpec("device-hash", v => c.DeviceHash = v),
                new SignedTokenCore.FieldSpec("config-id", v => c.ConfigId = v),
                new SignedTokenCore.FieldSpec("config-seq", v => configSeq = v),
                new SignedTokenCore.FieldSpec("config-hash", v => c.ConfigHash = v),
                new SignedTokenCore.FieldSpec("issued-at", v => issuedAt = v),
                new SignedTokenCore.FieldSpec("expires-at", v => expiresAt = v),
            };

            // config token uses validate_values=false (the C++ parser passes false here).
            if (!SignedTokenCore.TryParseCanonicalPayload(payloadText, fields, false, out error))
            {
                return false;
            }

            if (!SignedTokenCore.TryParseUInt64(configSeq, out ulong seq) ||
                !SignedTokenCore.TryParseUInt64(issuedAt, out ulong issued) ||
                !SignedTokenCore.TryParseUInt64(expiresAt, out ulong expires))
            {
                error = "integer field malformed";
                return false;
            }

            c.ConfigSeq = seq;
            c.IssuedAt = issued;
            c.ExpiresAt = expires;
            return true;
        }

        private static VerifyFailureCode ValidateClaims(ConfigTokenClaims claims, ConfigTokenExpected expected,
            out string error)
        {
            error = string.Empty;

            if (claims.Purpose != Purpose || claims.Version != Version ||
                claims.Algorithm != SignedTokenCore.AlgorithmRsaPkcs1Sha256)
            {
                error = "metadata mismatch";
                return VerifyFailureCode.Metadata;
            }

            if (claims.Project != expected.Project || claims.Feature != expected.Feature ||
                claims.LicenseFingerprint != expected.LicenseFingerprint ||
                claims.DeviceHash != expected.DeviceHash)
            {
                error = "request binding mismatch";
                return VerifyFailureCode.Binding;
            }

            string expectedConfigHash;
            using (SHA256 sha = SHA256.Create())
            {
                expectedConfigHash = "sha256:" + Hex.Encode(sha.ComputeHash(expected.ConfigBytes ?? new byte[0]));
            }

            if (claims.ConfigHash != expectedConfigHash)
            {
                error = "config hash does not match config bytes";
                return VerifyFailureCode.HashMismatch;
            }

            ulong now = expected.NowEpochSeconds == 0
                ? (ulong)System.DateTimeOffset.UtcNow.ToUnixTimeSeconds()
                : expected.NowEpochSeconds;

            if (claims.IssuedAt > now + (ulong)SignedTokenCore.IssuedAtFutureSkewSeconds)
            {
                error = "issued in the future";
                return VerifyFailureCode.Expired;
            }

            // Config tokens must carry a finite expiry (0 is rejected), matching the C++ verifier.
            if (claims.ExpiresAt == 0)
            {
                error = "config token has no expiry";
                return VerifyFailureCode.Expired;
            }

            if (claims.ExpiresAt < claims.IssuedAt || claims.ExpiresAt < now)
            {
                error = "config token expired";
                return VerifyFailureCode.Expired;
            }

            if (claims.ConfigSeq < expected.MinConfigSeq)
            {
                error = "config sequence is below the minimum";
                return VerifyFailureCode.Rollback;
            }

            return VerifyFailureCode.None;
        }

        /// <summary>Re-serialize claims to canonical payload bytes (parity testing).</summary>
        public static string BuildCanonicalPayload(ConfigTokenClaims claims)
        {
            var lines = new List<KeyValuePair<string, string>>
            {
                new KeyValuePair<string, string>("purpose", claims.Purpose),
                new KeyValuePair<string, string>("version", claims.Version),
                new KeyValuePair<string, string>("alg", claims.Algorithm),
                new KeyValuePair<string, string>("key-id", claims.KeyId),
                new KeyValuePair<string, string>("project", claims.Project),
                new KeyValuePair<string, string>("feature", claims.Feature),
                new KeyValuePair<string, string>("license-fingerprint", claims.LicenseFingerprint),
                new KeyValuePair<string, string>("device-hash", claims.DeviceHash),
                new KeyValuePair<string, string>("config-id", claims.ConfigId),
                new KeyValuePair<string, string>("config-seq", claims.ConfigSeq.ToString()),
                new KeyValuePair<string, string>("config-hash", claims.ConfigHash),
                new KeyValuePair<string, string>("issued-at", claims.IssuedAt.ToString()),
                new KeyValuePair<string, string>("expires-at", claims.ExpiresAt.ToString()),
            };
            return SignedTokenCore.BuildCanonicalPayload(lines);
        }
    }
}
