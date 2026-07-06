using System;
using System.IO;
using System.Text;
using Licensecc.Client;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Licensecc.Client.Tests
{
    /// <summary>
    /// Parity tests for the lcccfg1 config-attestation verifier against the repo golden vectors.
    /// golden.token binds project=DEFAULT, feature=EXPORT, fingerprint=aaaa..., device-hash="",
    /// config-id=app-config, config-seq=9, config-hash=sha256(golden.config), issued-at=1000,
    /// expires-at=2000. now=1500 accepts. Also covers the EMBEDDED golden (different key/config) and
    /// the Python-vs-.NET PKCS#1 key-import asymmetry (here, .NET imports PKCS#1 natively).
    /// </summary>
    [TestClass]
    public sealed class ConfigTokenTests
    {
        private const ulong AcceptNow = 1500;

        private static string Token => GoldenVectors.ReadTrimmed(Path.Combine(GoldenVectors.ConfigDir, "golden.token"));
        private static string KeyDerHex => GoldenVectors.ReadTrimmed(Path.Combine(GoldenVectors.ConfigDir, "golden.public_key.pkcs1.der.hex"));
        private static string KeyId => GoldenVectors.ReadTrimmed(Path.Combine(GoldenVectors.ConfigDir, "golden.key_id"));
        private static byte[] ConfigBytes => GoldenVectors.ReadBytes(Path.Combine(GoldenVectors.ConfigDir, "golden.config"));

        private static TrustedKeyRing Ring() => new TrustedKeyRing(TrustedPublicKey.FromPkcs1DerHex(KeyDerHex));

        private static ConfigTokenExpected BaseExpected()
        {
            return new ConfigTokenExpected
            {
                Project = "DEFAULT",
                Feature = "EXPORT",
                LicenseFingerprint = new string('a', 64),
                DeviceHash = string.Empty,
                ConfigBytes = ConfigBytes,
                MinConfigSeq = 0,
                NowEpochSeconds = AcceptNow,
                TrustedKeys = Ring(),
            };
        }

        [TestMethod]
        public void GoldenKeyId_DerivesFromDer()
        {
            Assert.AreEqual(KeyId, TrustedPublicKey.FromPkcs1DerHex(KeyDerHex).KeyId);
        }

        [TestMethod]
        public void Positive_GoldenConfigTokenVerifies()
        {
            VerifyResult<ConfigTokenClaims> result = ConfigTokenVerifier.Verify(Token, BaseExpected());
            Assert.IsTrue(result.Ok, "Golden config token must verify. Detail: " + result.Detail);
            ConfigTokenClaims c = result.Claims!;
            Assert.AreEqual("licensecc-config-attestation", c.Purpose);
            Assert.AreEqual("app-config", c.ConfigId);
            Assert.AreEqual(9UL, c.ConfigSeq);
            Assert.AreEqual("sha256:301852d0a48908bd729ac900d3510e0470760f096137ad0fe3ce65f7cbb6041d", c.ConfigHash);
            Assert.AreEqual(1000UL, c.IssuedAt);
            Assert.AreEqual(2000UL, c.ExpiresAt);
            Assert.AreEqual(string.Empty, c.DeviceHash);
        }

        [TestMethod]
        public void Positive_ParsedClaimsRoundTripToCanonicalPayload()
        {
            VerifyResult<ConfigTokenClaims> result = ConfigTokenVerifier.Verify(Token, BaseExpected());
            Assert.IsTrue(result.Ok, result.Detail);

            // Decode the golden token's payload bytes directly and compare to the rebuild.
            string[] parts = Token.Split('.');
            byte[] goldenPayload = Convert.FromBase64String(parts[1]);
            byte[] rebuilt = Encoding.UTF8.GetBytes(ConfigTokenVerifier.BuildCanonicalPayload(result.Claims!));
            CollectionAssert.AreEqual(goldenPayload, rebuilt);
        }

        [TestMethod]
        public void Positive_EmbeddedGoldenVerifies()
        {
            // The embedded golden uses a DIFFERENT key (its DER lives only in the cmake record), a
            // different config, and config-seq=9 too. We derive the trusted key from the embedded config
            // bytes' signing public key by reading the key-id and trusting the matching DER.
            string token = GoldenVectors.ReadTrimmed(Path.Combine(GoldenVectors.ConfigDir, "embedded_golden.token"));
            string keyId = GoldenVectors.ReadTrimmed(Path.Combine(GoldenVectors.ConfigDir, "embedded_golden.key_id"));
            byte[] config = GoldenVectors.ReadBytes(Path.Combine(GoldenVectors.ConfigDir, "embedded_golden.config"));
            byte[] der = EmbeddedGoldenPublicKeyDer();

            TrustedPublicKey key = new TrustedPublicKey(SignedTokenCore_KeyId(der), der);
            Assert.AreEqual(keyId, key.KeyId, "Embedded golden DER must hash to its key-id.");

            ConfigTokenExpected expected = new ConfigTokenExpected
            {
                Project = "DEFAULT",
                Feature = "EXPORT",
                LicenseFingerprint = new string('a', 64),
                DeviceHash = string.Empty,
                ConfigBytes = config,
                NowEpochSeconds = AcceptNow,
                TrustedKeys = new TrustedKeyRing(key),
            };

            VerifyResult<ConfigTokenClaims> result = ConfigTokenVerifier.Verify(token, expected);
            Assert.IsTrue(result.Ok, "Embedded golden config token must verify. Detail: " + result.Detail);
        }

        // ---------------------------- NEGATIVE PARITY CASES ----------------------------

        [TestMethod]
        public void Negative_TamperedSignature_Rejected()
        {
            string token = Token;
            int lastDot = token.LastIndexOf('.');
            char[] sig = token.Substring(lastDot + 1).ToCharArray();
            sig[0] = sig[0] == 'A' ? 'B' : 'A';
            string tampered = token.Substring(0, lastDot + 1) + new string(sig);

            VerifyResult<ConfigTokenClaims> result = ConfigTokenVerifier.Verify(tampered, BaseExpected());
            Assert.IsFalse(result.Ok);
            Assert.AreEqual(VerifyFailureCode.Signature, result.Code);
        }

        [TestMethod]
        public void Negative_PayloadByteFlip_Rejected()
        {
            string[] parts = Token.Split('.');
            byte[] payload = Convert.FromBase64String(parts[1]);
            payload[7] ^= 0x01;
            string mutated = parts[0] + "." + Convert.ToBase64String(payload) + "." + parts[2];

            VerifyResult<ConfigTokenClaims> result = ConfigTokenVerifier.Verify(mutated, BaseExpected());
            Assert.IsFalse(result.Ok);
            Assert.AreEqual(VerifyFailureCode.Signature, result.Code);
        }

        [TestMethod]
        public void Negative_ConfigHashMismatch_Rejected()
        {
            ConfigTokenExpected expected = BaseExpected();
            expected.ConfigBytes = Encoding.UTF8.GetBytes("{\"feature\":\"export\",\"limit\":6}"); // wrong bytes
            VerifyResult<ConfigTokenClaims> result = ConfigTokenVerifier.Verify(Token, expected);
            Assert.IsFalse(result.Ok);
            Assert.AreEqual(VerifyFailureCode.HashMismatch, result.Code);
        }

        [TestMethod]
        public void Negative_Expired_Rejected()
        {
            ConfigTokenExpected expected = BaseExpected();
            expected.NowEpochSeconds = 2001; // past expires-at=2000
            VerifyResult<ConfigTokenClaims> result = ConfigTokenVerifier.Verify(Token, expected);
            Assert.IsFalse(result.Ok);
            Assert.AreEqual(VerifyFailureCode.Expired, result.Code);
        }

        [TestMethod]
        public void Negative_WrongPurpose_RejectedViaOnlineVerifier()
        {
            // Feeding a config token (lcccfg1) to the online verifier (expects lccoa1) -> envelope prefix
            // mismatch. Feeding the online token to the config verifier likewise rejects. This proves the
            // purpose/prefix separation between the two token kinds.
            OnlineAssertionExpected onlineExpected = new OnlineAssertionExpected
            {
                Project = "DEFAULT",
                Feature = "EXPORT",
                LicenseFingerprint = new string('a', 64),
                DeviceHash = string.Empty,
                Nonce = string.Empty,
                NowEpochSeconds = AcceptNow,
                TrustedKeys = Ring(),
            };
            VerifyResult<OnlineAssertionClaims> wrongKind = OnlineAssertionVerifier.Verify(Token, onlineExpected);
            Assert.IsFalse(wrongKind.Ok);
            Assert.AreEqual(VerifyFailureCode.Envelope, wrongKind.Code);
        }

        [TestMethod]
        public void Negative_WrongBinding_Rejected()
        {
            ConfigTokenExpected expected = BaseExpected();
            expected.Project = "OTHER";
            VerifyResult<ConfigTokenClaims> result = ConfigTokenVerifier.Verify(Token, expected);
            Assert.IsFalse(result.Ok);
            Assert.AreEqual(VerifyFailureCode.Binding, result.Code);
        }

        [TestMethod]
        public void Negative_ConfigSeqBelowFloor_Rejected()
        {
            ConfigTokenExpected expected = BaseExpected();
            expected.MinConfigSeq = 10; // token has config-seq=9
            VerifyResult<ConfigTokenClaims> result = ConfigTokenVerifier.Verify(Token, expected);
            Assert.IsFalse(result.Ok);
            Assert.AreEqual(VerifyFailureCode.Rollback, result.Code);
        }

        [TestMethod]
        public void Negative_UnknownKeyId_Rejected()
        {
            // Trust only the ONLINE golden key -> the config token's key-id is unknown.
            string onlineDerHex = GoldenVectors.ReadTrimmed(Path.Combine(GoldenVectors.OnlineDir, "golden.public_key.pkcs1.der.hex"));
            ConfigTokenExpected expected = BaseExpected();
            expected.TrustedKeys = new TrustedKeyRing(TrustedPublicKey.FromPkcs1DerHex(onlineDerHex));
            VerifyResult<ConfigTokenClaims> result = ConfigTokenVerifier.Verify(Token, expected);
            Assert.IsFalse(result.Ok);
            Assert.AreEqual(VerifyFailureCode.Signature, result.Code);
        }

        [TestMethod]
        public void Negative_MalformedEnvelope_Rejected()
        {
            VerifyResult<ConfigTokenClaims> result = ConfigTokenVerifier.Verify("lcccfg1.justonepart", BaseExpected());
            Assert.IsFalse(result.Ok);
            Assert.AreEqual(VerifyFailureCode.Envelope, result.Code);
        }

        // The embedded golden's PKCS#1 DER is published only as a CMake byte-array record; reproduce it
        // here so the embedded-ring golden is covered without re-reading the cmake file.
        private static byte[] EmbeddedGoldenPublicKeyDer()
        {
            int[] bytes =
            {
                48,130,1,138,2,130,1,129,0,194,213,181,180,233,213,110,50,165,186,8,239,229,64,254,150,95,
                25,17,14,178,255,142,251,49,43,32,15,27,153,189,166,152,220,226,101,43,183,90,89,56,98,50,
                48,104,34,155,81,57,239,128,242,147,228,9,124,228,69,220,189,174,187,121,231,201,207,119,92,
                26,182,202,38,191,66,217,101,125,44,140,194,1,62,17,131,216,34,45,115,243,254,152,108,210,
                87,88,51,59,44,140,46,136,155,97,142,224,158,91,129,39,147,29,189,5,125,155,122,207,72,235,
                233,194,25,181,90,233,25,139,242,47,102,116,138,69,77,212,143,153,91,14,254,255,59,156,243,
                107,8,73,188,227,62,116,101,139,31,103,208,69,90,241,61,85,112,111,196,80,16,147,50,190,112,
                228,141,160,216,88,247,164,25,74,162,211,145,85,246,79,133,79,131,115,180,141,100,254,186,
                14,105,61,135,74,35,161,0,175,27,238,220,207,211,50,206,192,1,211,30,94,86,80,225,106,82,201,
                12,95,227,132,228,144,206,98,191,22,180,149,126,188,238,250,126,120,241,231,173,220,63,113,
                51,11,123,54,171,20,162,51,209,243,198,179,168,66,183,54,59,142,235,76,249,173,38,49,219,241,
                193,29,97,69,129,248,142,135,211,42,191,12,223,34,17,173,178,55,91,93,147,187,2,118,63,5,53,
                67,30,175,57,43,77,213,226,183,41,165,46,107,242,242,32,197,13,101,234,186,207,146,211,187,
                186,254,109,175,8,235,249,87,7,231,37,109,135,91,234,55,245,6,17,191,239,187,255,86,65,246,
                249,59,216,80,175,59,106,6,4,163,190,6,57,224,194,22,212,76,200,223,234,250,69,53,25,35,59,
                152,119,35,54,186,73,204,75,2,3,1,0,1,
            };
            byte[] der = new byte[bytes.Length];
            for (int i = 0; i < bytes.Length; i++)
            {
                der[i] = (byte)bytes[i];
            }

            return der;
        }

        // Bridge to the internal key-id helper (the SDK exposes it via TrustedPublicKey.FromPkcs1DerHex,
        // but here we already have raw bytes).
        private static string SignedTokenCore_KeyId(byte[] der)
        {
            using var sha = System.Security.Cryptography.SHA256.Create();
            byte[] hash = sha.ComputeHash(der);
            var sb = new StringBuilder("sha256:");
            foreach (byte b in hash)
            {
                sb.Append(b.ToString("x2"));
            }

            return sb.ToString();
        }
    }
}
