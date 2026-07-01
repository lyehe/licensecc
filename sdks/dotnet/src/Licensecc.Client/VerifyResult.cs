using System.Collections.Generic;

namespace Licensecc.Client
{
    /// <summary>
    /// Machine-readable rejection codes for token verification. Mirrors the fail-closed decision
    /// points of the C++ verifier (src/library/signed_token, online_verification, config_attestation).
    /// A bad token NEVER throws; it returns <see cref="VerifyResult{TClaims}"/> with <c>Ok == false</c>
    /// and one of these codes.
    /// </summary>
    public enum VerifyFailureCode
    {
        /// <summary>No failure (the result is accepted).</summary>
        None = 0,

        /// <summary>Envelope prefix wrong, arity wrong, or base64 not canonical / not decodable.</summary>
        Envelope,

        /// <summary>Signature did not verify, key-id unknown, or the key failed policy (e.g. &lt; 3072 bits).</summary>
        Signature,

        /// <summary>The token's key-id is in the caller's retired-key set; rejected before crypto,
        /// even if the key is still present in the trusted ring. Mirrors the C++ retired-key list.</summary>
        RetiredKey,

        /// <summary>Canonical payload malformed: wrong field order, missing/extra/duplicate field,
        /// missing trailing newline, embedded CR, or a non-numeric integer field.</summary>
        Payload,

        /// <summary>purpose / version / alg / status did not match the expected constants.</summary>
        Metadata,

        /// <summary>project / feature / license-fingerprint / device-hash / nonce binding mismatch.</summary>
        Binding,

        /// <summary>config-hash did not match sha256(config bytes).</summary>
        HashMismatch,

        /// <summary>Token expired, issued in the future, or the time window is malformed.</summary>
        Expired,

        /// <summary>revocation-seq / config-seq is below the caller-supplied anti-rollback floor.</summary>
        Rollback,
    }

    /// <summary>
    /// Result of an offline token verification. Either <c>Ok</c> with parsed <c>Claims</c>, or a typed
    /// rejection (<c>Ok == false</c>) carrying a <see cref="VerifyFailureCode"/> and a human-readable
    /// <c>Detail</c>. There are no exceptions on a bad token.
    /// </summary>
    /// <typeparam name="TClaims">The parsed claim record type for the token kind.</typeparam>
    public sealed class VerifyResult<TClaims> where TClaims : class
    {
        private VerifyResult(bool ok, TClaims? claims, VerifyFailureCode code, string detail)
        {
            Ok = ok;
            Claims = claims;
            Code = code;
            Detail = detail;
        }

        /// <summary>True when the token verified and all claims validated.</summary>
        public bool Ok { get; }

        /// <summary>The parsed claims when <see cref="Ok"/> is true; otherwise null.</summary>
        public TClaims? Claims { get; }

        /// <summary>The rejection code when <see cref="Ok"/> is false; <see cref="VerifyFailureCode.None"/> on success.</summary>
        public VerifyFailureCode Code { get; }

        /// <summary>Human-readable detail. Safe to log; never contains secrets.</summary>
        public string Detail { get; }

        internal static VerifyResult<TClaims> Success(TClaims claims) =>
            new VerifyResult<TClaims>(true, claims, VerifyFailureCode.None, "ok");

        internal static VerifyResult<TClaims> Failure(VerifyFailureCode code, string detail) =>
            new VerifyResult<TClaims>(false, null, code, detail);
    }

    /// <summary>
    /// A trusted RSA public key the verifier may select by <c>key-id</c>. The <c>KeyId</c> is the
    /// canonical <c>sha256:&lt;64-hex&gt;</c> over <c>PublicKeyDer</c> (PKCS#1 RSAPublicKey DER). The
    /// verifier rejects any key whose declared <c>KeyId</c> does not match that digest, mirroring
    /// <c>signature_public_key_record_allowed</c> in the C++ verifier.
    /// </summary>
    public sealed class TrustedPublicKey
    {
        /// <summary>Create a trusted key from a key-id and PKCS#1 RSAPublicKey DER bytes.</summary>
        public TrustedPublicKey(string keyId, byte[] publicKeyDer)
        {
            KeyId = keyId ?? string.Empty;
            PublicKeyDer = publicKeyDer ?? new byte[0];
        }

        /// <summary>The <c>sha256:&lt;64-hex&gt;</c> key-id.</summary>
        public string KeyId { get; }

        /// <summary>PKCS#1 RSAPublicKey DER (the same encoding used by <c>RSA.ImportRSAPublicKey</c>).</summary>
        public byte[] PublicKeyDer { get; }

        /// <summary>Build a <see cref="TrustedPublicKey"/> from a hex-encoded PKCS#1 DER public key,
        /// deriving the canonical key-id from the bytes (matching the C++ <c>public_key_id_from_der</c>).</summary>
        public static TrustedPublicKey FromPkcs1DerHex(string der_hex)
        {
            byte[] der = Hex.Decode(der_hex);
            string keyId = SignedTokenCore.KeyIdFromDer(der);
            return new TrustedPublicKey(keyId, der);
        }
    }

    /// <summary>A read-only set of trusted keys, indexable by key-id.</summary>
    public sealed class TrustedKeyRing
    {
        private readonly Dictionary<string, TrustedPublicKey> _byKeyId;

        /// <summary>Construct a ring from a sequence of trusted keys.</summary>
        public TrustedKeyRing(IEnumerable<TrustedPublicKey> keys)
        {
            _byKeyId = new Dictionary<string, TrustedPublicKey>();
            foreach (TrustedPublicKey key in keys)
            {
                // A duplicate key-id makes selection ambiguous; the C++ ring rejects duplicates outright.
                if (!string.IsNullOrEmpty(key.KeyId))
                {
                    _byKeyId[key.KeyId] = key;
                }
            }
        }

        /// <summary>Construct a ring from a single trusted key.</summary>
        public TrustedKeyRing(TrustedPublicKey key) : this(new[] { key }) { }

        /// <summary>Look up a trusted key by its key-id. Returns false (and the caller rejects) when unknown.</summary>
        public bool TryGet(string keyId, out TrustedPublicKey? key) => _byKeyId.TryGetValue(keyId, out key);
    }
}
