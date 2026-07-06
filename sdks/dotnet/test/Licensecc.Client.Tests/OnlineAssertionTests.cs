using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Licensecc.Client;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Licensecc.Client.Tests
{
    /// <summary>
    /// Parity tests for the lccoa1 online-assertion verifier against the repo golden vectors.
    /// The golden payload (golden.payload) carries: project=DEFAULT, feature=EXPORT,
    /// license-fingerprint=aaaa..., device-hash=bbbb..., nonce=cccc..., status=ok,
    /// issued-at=1000, expires-at=1300, cache-until=1600, revocation-seq=42. A "now" inside [1000,1300]
    /// (we use 1200) accepts the token; values outside drive the negative cases.
    /// </summary>
    [TestClass]
    public sealed class OnlineAssertionTests
    {
        private const ulong AcceptNow = 1200;

        private static string Token => GoldenVectors.ReadTrimmed(Path.Combine(GoldenVectors.OnlineDir, "golden.assertion"));
        private static string KeyDerHex => GoldenVectors.ReadTrimmed(Path.Combine(GoldenVectors.OnlineDir, "golden.public_key.pkcs1.der.hex"));
        private static string KeyId => GoldenVectors.ReadTrimmed(Path.Combine(GoldenVectors.OnlineDir, "golden.key_id"));

        private static TrustedKeyRing Ring()
        {
            return new TrustedKeyRing(TrustedPublicKey.FromPkcs1DerHex(KeyDerHex));
        }

        private static OnlineAssertionExpected BaseExpected()
        {
            return new OnlineAssertionExpected
            {
                Project = "DEFAULT",
                Feature = "EXPORT",
                LicenseFingerprint = new string('a', 64),
                DeviceHash = new string('b', 64),
                Nonce = new string('c', 64),
                MinRevocationSeq = 0,
                NowEpochSeconds = AcceptNow,
                TrustedKeys = Ring(),
            };
        }

        [TestMethod]
        public void GoldenKeyId_DerivesFromDer()
        {
            // The key-id file must equal sha256: over the PKCS#1 DER bytes (mirrors public_key_id_from_der).
            TrustedPublicKey key = TrustedPublicKey.FromPkcs1DerHex(KeyDerHex);
            Assert.AreEqual(KeyId, key.KeyId);
        }

        [TestMethod]
        public void Pkcs1DerImports_WithoutSpkiWrapping()
        {
            // The known key-import asymmetry: .NET RSA.ImportRSAPublicKey consumes PKCS#1 RSAPublicKey
            // DER ("3082...0282...") natively, no SubjectPublicKeyInfo wrapping. A successful verify of
            // the golden token below is the end-to-end proof; here we assert the DER shape explicitly.
            byte[] der = HexToBytes(KeyDerHex);
            Assert.AreEqual(0x30, der[0], "PKCS#1 RSAPublicKey is a DER SEQUENCE (0x30).");
            using var rsa = System.Security.Cryptography.RSA.Create();
            rsa.ImportRSAPublicKey(der, out int read);
            Assert.AreEqual(der.Length, read);
            Assert.IsTrue(rsa.KeySize >= 3072, "Golden online key must satisfy the 3072-bit floor.");
        }

        [TestMethod]
        public void Positive_GoldenAssertionVerifies()
        {
            VerifyResult<OnlineAssertionClaims> result = OnlineAssertionVerifier.Verify(Token, BaseExpected());

            Assert.IsTrue(result.Ok, "Golden assertion must verify. Detail: " + result.Detail);
            Assert.AreEqual(VerifyFailureCode.None, result.Code);
            OnlineAssertionClaims c = result.Claims!;
            Assert.AreEqual("licensecc-online-assertion", c.Purpose);
            Assert.AreEqual("1", c.Version);
            Assert.AreEqual("rsa-pkcs1-sha256", c.Algorithm);
            Assert.AreEqual(KeyId, c.KeyId);
            Assert.AreEqual("DEFAULT", c.Project);
            Assert.AreEqual("EXPORT", c.Feature);
            Assert.AreEqual(new string('a', 64), c.LicenseFingerprint);
            Assert.AreEqual(new string('b', 64), c.DeviceHash);
            Assert.AreEqual(new string('c', 64), c.Nonce);
            Assert.AreEqual("ok", c.Status);
            Assert.AreEqual(1000UL, c.IssuedAt);
            Assert.AreEqual(1300UL, c.ExpiresAt);
            Assert.AreEqual(1600UL, c.CacheUntil);
            Assert.AreEqual(42UL, c.RevocationSeq);
        }

        [TestMethod]
        public void Positive_ParsedClaimsRoundTripToGoldenPayloadBytes()
        {
            // The parse must reproduce golden.payload EXACTLY (canonical bytes, trailing \n, no \r).
            VerifyResult<OnlineAssertionClaims> result = OnlineAssertionVerifier.Verify(Token, BaseExpected());
            Assert.IsTrue(result.Ok, result.Detail);

            string rebuilt = OnlineAssertionVerifier.BuildCanonicalPayload(result.Claims!);
            byte[] rebuiltBytes = Encoding.UTF8.GetBytes(rebuilt);
            byte[] goldenBytes = GoldenVectors.ReadBytes(Path.Combine(GoldenVectors.OnlineDir, "golden.payload"));

            CollectionAssert.AreEqual(goldenBytes, rebuiltBytes,
                "Rebuilt canonical payload must be byte-identical to golden.payload.");
        }

        [TestMethod]
        public void Positive_NonceUnsuppliedStillVerifies()
        {
            // When the caller does not present a live nonce (e.g. validating a cached token), the nonce
            // is shape-checked but not compared.
            OnlineAssertionExpected expected = BaseExpected();
            expected.Nonce = string.Empty;
            VerifyResult<OnlineAssertionClaims> result = OnlineAssertionVerifier.Verify(Token, expected);
            Assert.IsTrue(result.Ok, result.Detail);
        }

        // ---------------------------- NEGATIVE PARITY CASES ----------------------------

        [TestMethod]
        public void Negative_TamperedSignature_Rejected()
        {
            string token = Token;
            int lastDot = token.LastIndexOf('.');
            // Flip one base64 char of the signature (keep it in-alphabet & canonical-length).
            char[] sig = token.Substring(lastDot + 1).ToCharArray();
            sig[0] = sig[0] == 'A' ? 'B' : 'A';
            string tampered = token.Substring(0, lastDot + 1) + new string(sig);

            VerifyResult<OnlineAssertionClaims> result = OnlineAssertionVerifier.Verify(tampered, BaseExpected());
            Assert.IsFalse(result.Ok);
            Assert.AreEqual(VerifyFailureCode.Signature, result.Code);
        }

        [TestMethod]
        public void Negative_PayloadByteFlip_Rejected()
        {
            // Decode payload, flip one byte, re-encode the envelope -> signature no longer matches.
            string token = Token;
            string[] parts = token.Split('.');
            byte[] payload = Convert.FromBase64String(parts[1]);
            payload[5] ^= 0x01;
            string mutated = parts[0] + "." + Convert.ToBase64String(payload) + "." + parts[2];

            VerifyResult<OnlineAssertionClaims> result = OnlineAssertionVerifier.Verify(mutated, BaseExpected());
            Assert.IsFalse(result.Ok);
            Assert.AreEqual(VerifyFailureCode.Signature, result.Code);
        }

        [TestMethod]
        public void Negative_Expired_Rejected()
        {
            // now past expires-at (1300) and past cache-until (1600), no cache allowed.
            OnlineAssertionExpected expected = BaseExpected();
            expected.NowEpochSeconds = 1700;
            VerifyResult<OnlineAssertionClaims> result = OnlineAssertionVerifier.Verify(Token, expected);
            Assert.IsFalse(result.Ok);
            Assert.AreEqual(VerifyFailureCode.Expired, result.Code);
        }

        [TestMethod]
        public void Negative_ExpiredButWithinCache_RejectedWhenCacheDisallowed_AcceptedWhenAllowed()
        {
            // now in (expires-at, cache-until] = (1300, 1600].
            OnlineAssertionExpected noCache = BaseExpected();
            noCache.NowEpochSeconds = 1500;
            noCache.AllowCache = false;
            VerifyResult<OnlineAssertionClaims> rejected = OnlineAssertionVerifier.Verify(Token, noCache);
            Assert.IsFalse(rejected.Ok);
            Assert.AreEqual(VerifyFailureCode.Expired, rejected.Code);

            OnlineAssertionExpected withCache = BaseExpected();
            withCache.NowEpochSeconds = 1500;
            withCache.AllowCache = true;
            VerifyResult<OnlineAssertionClaims> accepted = OnlineAssertionVerifier.Verify(Token, withCache);
            Assert.IsTrue(accepted.Ok, accepted.Detail);
        }

        [TestMethod]
        public void Negative_WrongProjectBinding_Rejected()
        {
            OnlineAssertionExpected expected = BaseExpected();
            expected.Project = "OTHER";
            AssertRejected(expected, VerifyFailureCode.Binding);
        }

        [TestMethod]
        public void Negative_WrongFeatureBinding_Rejected()
        {
            OnlineAssertionExpected expected = BaseExpected();
            expected.Feature = "IMPORT";
            AssertRejected(expected, VerifyFailureCode.Binding);
        }

        [TestMethod]
        public void Negative_WrongFingerprintBinding_Rejected()
        {
            OnlineAssertionExpected expected = BaseExpected();
            expected.LicenseFingerprint = new string('d', 64);
            AssertRejected(expected, VerifyFailureCode.Binding);
        }

        [TestMethod]
        public void Negative_WrongDeviceHashBinding_Rejected()
        {
            OnlineAssertionExpected expected = BaseExpected();
            expected.DeviceHash = new string('e', 64);
            AssertRejected(expected, VerifyFailureCode.Binding);
        }

        [TestMethod]
        public void Negative_WrongNonce_Rejected()
        {
            OnlineAssertionExpected expected = BaseExpected();
            expected.Nonce = new string('f', 64);
            AssertRejected(expected, VerifyFailureCode.Binding);
        }

        [TestMethod]
        public void Negative_RevocationSeqBelowFloor_Rejected()
        {
            OnlineAssertionExpected expected = BaseExpected();
            expected.MinRevocationSeq = 43; // token has revocation-seq=42
            AssertRejected(expected, VerifyFailureCode.Rollback);
        }

        [TestMethod]
        public void Negative_UnknownKeyId_Rejected()
        {
            // Trust a DIFFERENT key (the config golden key) -> the assertion's key-id is unknown.
            string otherDerHex = GoldenVectors.ReadTrimmed(Path.Combine(GoldenVectors.ConfigDir, "golden.public_key.pkcs1.der.hex"));
            OnlineAssertionExpected expected = BaseExpected();
            expected.TrustedKeys = new TrustedKeyRing(TrustedPublicKey.FromPkcs1DerHex(otherDerHex));
            AssertRejected(expected, VerifyFailureCode.Signature);
        }

        [TestMethod]
        public void Negative_MalformedEnvelope_Rejected()
        {
            foreach (string bad in new[]
            {
                "lccoa1.onlyonepart",
                "lccoa1.a.b.c",                              // too many dots
                "WRONGPREFIX." + Token.Substring(Token.IndexOf('.') + 1),
                "lccoa1.!!!notbase64!!!." + Token.Split('.')[2],
                "lccoa1..",                                  // empty parts
                "",                                          // empty
            })
            {
                VerifyResult<OnlineAssertionClaims> result = OnlineAssertionVerifier.Verify(bad, BaseExpected());
                Assert.IsFalse(result.Ok, "Expected rejection for: " + bad);
                Assert.AreEqual(VerifyFailureCode.Envelope, result.Code, "For input: " + bad);
            }
        }

        [TestMethod]
        public void Negative_NonCanonicalBase64Payload_Rejected()
        {
            // Re-encode the payload with url-safe alphabet -> not canonical standard base64 -> Envelope reject.
            string[] parts = Token.Split('.');
            string urlSafe = parts[1].Replace('+', '-').Replace('/', '_');
            if (urlSafe == parts[1])
            {
                // The golden payload happens to lack + or /, so force a non-canonical form by stripping padding.
                urlSafe = parts[1].TrimEnd('=');
            }

            string mutated = parts[0] + "." + urlSafe + "." + parts[2];
            VerifyResult<OnlineAssertionClaims> result = OnlineAssertionVerifier.Verify(mutated, BaseExpected());
            Assert.IsFalse(result.Ok);
            Assert.AreEqual(VerifyFailureCode.Envelope, result.Code);
        }

        [TestMethod]
        public void Negative_NoTrustedKeys_Rejected()
        {
            OnlineAssertionExpected expected = BaseExpected();
            expected.TrustedKeys = null;
            VerifyResult<OnlineAssertionClaims> result = OnlineAssertionVerifier.Verify(Token, expected);
            Assert.IsFalse(result.Ok);
            Assert.AreEqual(VerifyFailureCode.Signature, result.Code);
        }

        private static void AssertRejected(OnlineAssertionExpected expected, VerifyFailureCode expectedCode)
        {
            VerifyResult<OnlineAssertionClaims> result = OnlineAssertionVerifier.Verify(Token, expected);
            Assert.IsFalse(result.Ok, "Expected rejection (" + expectedCode + ") but token was accepted.");
            Assert.AreEqual(expectedCode, result.Code, "Detail: " + result.Detail);
        }

        [TestMethod]
        public void Negative_RetiredKeyId_RejectedBeforeCrypto()
        {
            // The golden token's own key-id, marked retired, is rejected even though the key is still
            // in the trusted ring for continuity (matches the C++ retired-key list, before crypto).
            OnlineAssertionExpected expected = BaseExpected();
            expected.RetiredKeyIds = new HashSet<string> { KeyId };
            VerifyResult<OnlineAssertionClaims> result = OnlineAssertionVerifier.Verify(Token, expected);
            Assert.IsFalse(result.Ok);
            Assert.AreEqual(VerifyFailureCode.RetiredKey, result.Code);
        }

        [TestMethod]
        public void Positive_RetiredSetNotMatchingKeyId_StillVerifies()
        {
            OnlineAssertionExpected expected = BaseExpected();
            expected.RetiredKeyIds = new HashSet<string> { "sha256:" + new string('0', 64) };
            VerifyResult<OnlineAssertionClaims> result = OnlineAssertionVerifier.Verify(Token, expected);
            Assert.IsTrue(result.Ok, result.Detail);
        }

        private static byte[] HexToBytes(string hex)
        {
            byte[] bytes = new byte[hex.Length / 2];
            for (int i = 0; i < bytes.Length; i++)
            {
                bytes[i] = Convert.ToByte(hex.Substring(2 * i, 2), 16);
            }

            return bytes;
        }
    }
}
