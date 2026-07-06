using System;
using System.Security.Cryptography;
using Licensecc.Client;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Licensecc.Client.Tests
{
    /// <summary>
    /// Edge-case coverage for the shared core: canonical base64, parse_uint64 overflow/non-digit, and
    /// the PKCS#1-vs-SPKI key-import asymmetry. These pin the fail-closed behavior independent of the
    /// golden tokens.
    /// </summary>
    [TestClass]
    public sealed class CoreEdgeCaseTests
    {
        [TestMethod]
        public void CanonicalBase64_RejectsUrlSafeAndWhitespaceAndNonMinimalPadding()
        {
            // Standard base64 of "hello" is "aGVsbG8=".
            Assert.IsTrue(SignedTokenCore.TryDecodeCanonicalBase64("aGVsbG8=", out byte[] ok));
            Assert.AreEqual("hello", System.Text.Encoding.UTF8.GetString(ok));

            // url-safe alphabet using '-'/'_': craft bytes that produce '+' or '/' in standard form.
            byte[] raw = { 0xFB, 0xFF, 0xBF };           // standard base64 = "+/+/"
            string standard = Convert.ToBase64String(raw); // "+/+/"
            Assert.AreEqual("+/+/", standard);
            string urlSafe = standard.Replace('+', '-').Replace('/', '_'); // "-_-_"
            Assert.IsFalse(SignedTokenCore.TryDecodeCanonicalBase64(urlSafe, out _), "url-safe must be rejected");

            // Whitespace / newline must be rejected (allow_line_breaks=false).
            Assert.IsFalse(SignedTokenCore.TryDecodeCanonicalBase64("aGVs\nbG8=", out _));
            Assert.IsFalse(SignedTokenCore.TryDecodeCanonicalBase64("aGVsbG8 =", out _));

            // Missing padding must be rejected (non-canonical).
            Assert.IsFalse(SignedTokenCore.TryDecodeCanonicalBase64("aGVsbG8", out _));

            // Empty must be rejected.
            Assert.IsFalse(SignedTokenCore.TryDecodeCanonicalBase64("", out _));
        }

        [TestMethod]
        public void ParseUInt64_RejectsNonDigitAndOverflow_AcceptsValid()
        {
            Assert.IsTrue(SignedTokenCore.TryParseUInt64("0", out ulong z) && z == 0);
            Assert.IsTrue(SignedTokenCore.TryParseUInt64("18446744073709551615", out ulong max) && max == ulong.MaxValue);
            Assert.IsFalse(SignedTokenCore.TryParseUInt64("", out _));
            Assert.IsFalse(SignedTokenCore.TryParseUInt64("12a3", out _));
            Assert.IsFalse(SignedTokenCore.TryParseUInt64("-1", out _));
            Assert.IsFalse(SignedTokenCore.TryParseUInt64("18446744073709551616", out _)); // overflow
        }

        [TestMethod]
        public void Pkcs1Der_ImportsViaImportRSAPublicKey_ButNotViaSpkiImporter()
        {
            // Generate a 3072-bit key, export PKCS#1 (RSAPublicKey) and SPKI (SubjectPublicKeyInfo).
            using var source = RSA.Create(3072);
            byte[] pkcs1 = source.ExportRSAPublicKey();
            byte[] spki = source.ExportSubjectPublicKeyInfo();
            Assert.AreNotEqual(Convert.ToBase64String(pkcs1), Convert.ToBase64String(spki),
                "PKCS#1 and SPKI encodings differ (SPKI wraps PKCS#1 in an AlgorithmIdentifier).");

            // .NET ImportRSAPublicKey consumes PKCS#1 natively (this is the encoding the golden keys use).
            using (var viaPkcs1 = RSA.Create())
            {
                viaPkcs1.ImportRSAPublicKey(pkcs1, out int read);
                Assert.AreEqual(pkcs1.Length, read);
                Assert.AreEqual(3072, viaPkcs1.KeySize);
            }

            // The asymmetry the task calls out: an SPKI importer (ImportSubjectPublicKeyInfo, the analog
            // of Python cryptography's load_der_public_key) does NOT accept bare PKCS#1 bytes. This is
            // exactly why a Python port must SPKI-wrap the golden DER; .NET does not.
            using (var viaSpki = RSA.Create())
            {
                Assert.ThrowsException<CryptographicException>(() => viaSpki.ImportSubjectPublicKeyInfo(pkcs1, out _));
                // ...but it DOES accept the SPKI encoding.
                viaSpki.ImportSubjectPublicKeyInfo(spki, out int spkiRead);
                Assert.AreEqual(spki.Length, spkiRead);
            }
        }

        [TestMethod]
        public void TrustedKeyRing_RejectsUnknownKeyId()
        {
            using var rsa = RSA.Create(3072);
            byte[] der = rsa.ExportRSAPublicKey();
            string keyId = SignedTokenCore.KeyIdFromDer(der);
            var ring = new TrustedKeyRing(new TrustedPublicKey(keyId, der));

            Assert.IsTrue(ring.TryGet(keyId, out TrustedPublicKey? found) && found != null);
            Assert.IsFalse(ring.TryGet("sha256:" + new string('0', 64), out _));
        }
    }
}
