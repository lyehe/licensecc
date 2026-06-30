using System.Collections.Generic;

namespace Licensecc.Client
{
    /// <summary>
    /// The parsed claims of an <c>lccoa1.</c> online-assertion token, in canonical field order. All
    /// string fields are the raw payload values; the four time/sequence fields are parsed integers.
    /// </summary>
    public sealed class OnlineAssertionClaims
    {
        public string Purpose { get; internal set; } = string.Empty;
        public string Version { get; internal set; } = string.Empty;
        public string Algorithm { get; internal set; } = string.Empty;
        public string KeyId { get; internal set; } = string.Empty;
        public string Project { get; internal set; } = string.Empty;
        public string Feature { get; internal set; } = string.Empty;
        public string LicenseFingerprint { get; internal set; } = string.Empty;
        public string DeviceHash { get; internal set; } = string.Empty;
        public string Nonce { get; internal set; } = string.Empty;
        public string Status { get; internal set; } = string.Empty;
        public ulong IssuedAt { get; internal set; }
        public ulong ExpiresAt { get; internal set; }
        public ulong CacheUntil { get; internal set; }
        public ulong RevocationSeq { get; internal set; }
    }

    /// <summary>
    /// Caller-supplied expectations the online assertion is validated against. Field semantics mirror
    /// <c>OnlineVerificationExpected</c> in the C++ verifier.
    /// </summary>
    public sealed class OnlineAssertionExpected
    {
        /// <summary>Expected <c>project</c> binding (required).</summary>
        public string Project { get; set; } = string.Empty;

        /// <summary>Expected <c>feature</c> binding (required).</summary>
        public string Feature { get; set; } = string.Empty;

        /// <summary>Expected <c>license-fingerprint</c> (64-hex) binding (required).</summary>
        public string LicenseFingerprint { get; set; } = string.Empty;

        /// <summary>Expected <c>device-hash</c> (64-hex or empty) binding. Empty means "no device binding".</summary>
        public string DeviceHash { get; set; } = string.Empty;

        /// <summary>
        /// Expected <c>nonce</c>. When non-empty it must equal the token nonce (anti-replay). When the
        /// caller leaves it empty, the nonce is parsed/validated for shape but not compared — use this
        /// to verify a cached/standalone token where the live challenge nonce is unknown.
        /// </summary>
        public string Nonce { get; set; } = string.Empty;

        /// <summary>When false (default), the nonce, when supplied, must match and an expired token is
        /// rejected outright. When true, a token past <c>expires-at</c> (or a nonce mismatch) is accepted
        /// if <c>cache-until &gt;= now</c>, matching the C++ cache fallback.</summary>
        public bool AllowCache { get; set; }

        /// <summary>Anti-rollback floor: the token's <c>revocation-seq</c> must be &gt;= this value.</summary>
        public ulong MinRevocationSeq { get; set; }

        /// <summary>Maximum allowed <c>cache-until - issued-at</c> window (default: effectively unbounded).</summary>
        public ulong MaxCacheSeconds { get; set; } = ulong.MaxValue;

        /// <summary>The reference "now" in Unix seconds. 0 means "use the system clock".</summary>
        public ulong NowEpochSeconds { get; set; }

        /// <summary>The trusted key ring the signature is verified against. Required.</summary>
        public TrustedKeyRing? TrustedKeys { get; set; }
    }

    /// <summary>
    /// Offline verifier for the <c>lccoa1.</c> online-assertion token — the verifier's primary target.
    /// Mirrors <c>verify_assertion_envelope</c> + <c>parse_canonical_payload</c> + <c>validate_claims</c>
    /// in <c>src/library/online_verification/OnlineVerification.cpp</c>, fail-closed.
    /// </summary>
    public static class OnlineAssertionVerifier
    {
        public const string EnvelopePrefix = "lccoa1";
        public const string Purpose = "licensecc-online-assertion";
        public const string Version = "1";

        private const int FingerprintHexLength = 64;
        private const int NonceHexLength = 64;
        private const int DeviceHashHexLength = 64;

        /// <summary>
        /// Verify and validate an online-assertion token against <paramref name="expected"/>. Returns a
        /// typed result; never throws on a malformed/invalid token.
        /// </summary>
        public static VerifyResult<OnlineAssertionClaims> Verify(string token, OnlineAssertionExpected expected)
        {
            if (expected == null || expected.TrustedKeys == null)
            {
                return VerifyResult<OnlineAssertionClaims>.Failure(
                    VerifyFailureCode.Signature, "no trusted keys configured");
            }

            if (!SignedTokenCore.TrySplitEnvelope(token, EnvelopePrefix, out byte[] payload,
                    out byte[] signature, out string envelopeError))
            {
                return VerifyResult<OnlineAssertionClaims>.Failure(VerifyFailureCode.Envelope, envelopeError);
            }

            string payloadText = System.Text.Encoding.UTF8.GetString(payload);

            if (!SignedTokenCore.TryVerifySignature(payload, signature, payloadText, expected.TrustedKeys,
                    out string signatureError))
            {
                return VerifyResult<OnlineAssertionClaims>.Failure(VerifyFailureCode.Signature, signatureError);
            }

            if (!TryParseClaims(payloadText, out OnlineAssertionClaims claims, out string parseError))
            {
                return VerifyResult<OnlineAssertionClaims>.Failure(VerifyFailureCode.Payload, parseError);
            }

            VerifyFailureCode validateCode = ValidateClaims(claims, expected, out string validateError);
            if (validateCode != VerifyFailureCode.None)
            {
                return VerifyResult<OnlineAssertionClaims>.Failure(validateCode, validateError);
            }

            return VerifyResult<OnlineAssertionClaims>.Success(claims);
        }

        private static bool TryParseClaims(string payloadText, out OnlineAssertionClaims claims, out string error)
        {
            claims = new OnlineAssertionClaims();
            OnlineAssertionClaims c = claims;
            string issuedAt = string.Empty, expiresAt = string.Empty, cacheUntil = string.Empty, revocationSeq = string.Empty;

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
                new SignedTokenCore.FieldSpec("nonce", v => c.Nonce = v),
                new SignedTokenCore.FieldSpec("status", v => c.Status = v),
                new SignedTokenCore.FieldSpec("issued-at", v => issuedAt = v),
                new SignedTokenCore.FieldSpec("expires-at", v => expiresAt = v),
                new SignedTokenCore.FieldSpec("cache-until", v => cacheUntil = v),
                new SignedTokenCore.FieldSpec("revocation-seq", v => revocationSeq = v),
            };

            // online assertion uses validate_values=true (no '=' / CR / LF inside any value).
            if (!SignedTokenCore.TryParseCanonicalPayload(payloadText, fields, true, out error))
            {
                return false;
            }

            if (!SignedTokenCore.TryParseUInt64(issuedAt, out ulong issued) ||
                !SignedTokenCore.TryParseUInt64(expiresAt, out ulong expires) ||
                !SignedTokenCore.TryParseUInt64(cacheUntil, out ulong cache) ||
                !SignedTokenCore.TryParseUInt64(revocationSeq, out ulong revocation))
            {
                error = "integer field malformed";
                return false;
            }

            c.IssuedAt = issued;
            c.ExpiresAt = expires;
            c.CacheUntil = cache;
            c.RevocationSeq = revocation;
            return true;
        }

        private static VerifyFailureCode ValidateClaims(OnlineAssertionClaims claims,
            OnlineAssertionExpected expected, out string error)
        {
            error = string.Empty;
            ulong now = expected.NowEpochSeconds == 0
                ? (ulong)System.DateTimeOffset.UtcNow.ToUnixTimeSeconds()
                : expected.NowEpochSeconds;

            if (claims.Purpose != Purpose || claims.Version != Version ||
                claims.Algorithm != SignedTokenCore.AlgorithmRsaPkcs1Sha256)
            {
                error = "metadata mismatch";
                return VerifyFailureCode.Metadata;
            }

            if (claims.Status != "ok" && claims.Status != "denied")
            {
                error = "status unsupported";
                return VerifyFailureCode.Metadata;
            }

            if (claims.Status == "denied")
            {
                error = "denied entitlement";
                return VerifyFailureCode.Metadata;
            }

            if (claims.Project != expected.Project || claims.Feature != expected.Feature ||
                claims.LicenseFingerprint != expected.LicenseFingerprint ||
                claims.DeviceHash != expected.DeviceHash)
            {
                error = "request binding mismatch";
                return VerifyFailureCode.Binding;
            }

            if (!Hex.IsAsciiHex(claims.LicenseFingerprint, FingerprintHexLength) ||
                !Hex.IsAsciiHex(claims.Nonce, NonceHexLength))
            {
                error = "hex field malformed";
                return VerifyFailureCode.Binding;
            }

            if (claims.DeviceHash.Length != 0 && !Hex.IsAsciiHex(claims.DeviceHash, DeviceHashHexLength))
            {
                error = "device hash malformed";
                return VerifyFailureCode.Binding;
            }

            // Time window shape: issued-at within +skew, expires-at >= issued-at, cache-until >= expires-at.
            if (claims.IssuedAt > now + (ulong)SignedTokenCore.IssuedAtFutureSkewSeconds ||
                claims.ExpiresAt < claims.IssuedAt || claims.CacheUntil < claims.ExpiresAt)
            {
                error = "time window malformed";
                return VerifyFailureCode.Expired;
            }

            if (claims.CacheUntil - claims.IssuedAt > expected.MaxCacheSeconds)
            {
                error = "cache window exceeds maximum";
                return VerifyFailureCode.Expired;
            }

            if (claims.RevocationSeq < expected.MinRevocationSeq)
            {
                error = "revocation sequence is below minimum";
                return VerifyFailureCode.Rollback;
            }

            // Nonce comparison only when the caller supplied one (live anti-replay challenge).
            if (expected.Nonce.Length != 0 && claims.Nonce != expected.Nonce)
            {
                if (expected.AllowCache && claims.CacheUntil >= now)
                {
                    return VerifyFailureCode.None;
                }

                error = "request binding mismatch";
                return VerifyFailureCode.Binding;
            }

            if (claims.ExpiresAt >= now)
            {
                return VerifyFailureCode.None;
            }

            if (expected.AllowCache && claims.CacheUntil >= now)
            {
                return VerifyFailureCode.None;
            }

            error = expected.AllowCache ? "cache expired" : "expired";
            return VerifyFailureCode.Expired;
        }

        /// <summary>Re-serialize claims to the canonical payload bytes — used by parity tests to confirm
        /// the parse round-trips back to <c>golden.payload</c> exactly.</summary>
        public static string BuildCanonicalPayload(OnlineAssertionClaims claims)
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
                new KeyValuePair<string, string>("nonce", claims.Nonce),
                new KeyValuePair<string, string>("status", claims.Status),
                new KeyValuePair<string, string>("issued-at", claims.IssuedAt.ToString()),
                new KeyValuePair<string, string>("expires-at", claims.ExpiresAt.ToString()),
                new KeyValuePair<string, string>("cache-until", claims.CacheUntil.ToString()),
                new KeyValuePair<string, string>("revocation-seq", claims.RevocationSeq.ToString()),
            };
            return SignedTokenCore.BuildCanonicalPayload(lines);
        }
    }
}
