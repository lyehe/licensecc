using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Licensecc.Client.Tests;

// Independent test-only wire/crypto oracle. This does not authorize application use.
[TestClass]
public sealed class DeviceBoundVectorsTests
{
    private static readonly BigInteger Order = new BigInteger(Convert.FromHexString(
        "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"), true, true);

    [TestMethod]
    [DataRow("protocol.json", "renew")]
    [DataRow("exchange.json", "exchange")]
    public void ProofAndOperationBytes(string filename, string purpose)
    {
        using JsonDocument document = Read(filename);
        JsonElement vector = document.RootElement;
        JsonElement body = vector.GetProperty("body"), proof = vector.GetProperty("proof");
        Assert.AreEqual(Value(body, "operation_id"), Value(proof, "operation_id"));
        Assert.AreEqual("POST", Value(proof, "method"));
        Assert.AreEqual(purpose == "renew" ? "/v2/device-leases/renew"
            : "/v2/device-authorizations/exchange", Value(proof, "path"));
        object[] values = purpose == "renew"
            ? new object[] { Encoded(body, "binding_id"), body.GetProperty("generation").GetInt64(), Encoded(body, "operation_id") }
            : new[] { "attempt_handle", "code", "code_verifier", "redirect_uri", "operation_id" }
                .Select(field => (object)Encoded(body, field)).ToArray();
        byte[] semantic = JsonSerializer.SerializeToUtf8Bytes(values);
        Assert.AreEqual(Value(proof, "body_sha256"), Hash(semantic));
        byte[] operation = Bytes("lcc-device-operation-v1\n" + B64(Bytes(purpose)) + "\n"
            + Encoded(proof, "key_id") + "\n" + B64(semantic) + "\n");
        Assert.AreEqual(Value(vector, "operation_digest_input_hex"), Hex(operation));
        Assert.AreEqual(Value(vector, "operation_digest"), Hash(operation));
        var transcript = new StringBuilder("lcc-device-proof-v2\n");
        foreach (string field in new[] { "audience", "method", "path", "key_id", "operation_id",
            "body_sha256", "challenge_id", "nonce" }) transcript.Append(Encoded(proof, field)).Append('\n');
        transcript.Append(proof.GetProperty("expires_at").GetInt64().ToString(CultureInfo.InvariantCulture)).Append('\n');
        byte[] input = Bytes(transcript.ToString());
        Assert.AreEqual(Value(vector, "proof_input_hex"), Hex(input));
        byte[] der = Decode(Value(vector, "device_spki"));
        Assert.AreEqual(Value(proof, "key_id"), "sha256:" + Hash(der));
        using ECDsa key = ECDsa.Create();
        key.ImportSubjectPublicKeyInfo(der, out int consumed);
        Assert.AreEqual(der.Length, consumed);
        Assert.AreEqual(256, key.KeySize);
        Assert.AreEqual(91, der.Length);
        Assert.AreEqual("3059301306072a8648ce3d020106082a8648ce3d03010703420004", Hex(der.Take(27).ToArray()));
        CollectionAssert.AreEqual(der, key.ExportSubjectPublicKeyInfo());
        byte[] signature = Decode(Value(vector, "proof_signature"));
        Assert.IsTrue(LowS(signature));
        Assert.IsTrue(VerifyProof(key, input, signature));
        byte[] changed = (byte[])input.Clone();
        changed[0] ^= 1;
        Assert.IsFalse(VerifyProof(key, changed, signature), "Changed proof domain");
        byte[] high = (byte[])signature.Clone();
        byte[] highS = (Order - new BigInteger(signature.AsSpan(32), true, true)).ToByteArray(true, true);
        Assert.AreEqual(32, highS.Length);
        highS.CopyTo(high, 32);
        Assert.IsTrue(VerifyProof(key, input, high), "High-S is mathematically valid");
        Assert.IsFalse(LowS(high), "Protocol must reject malleable high-S");
        Assert.IsFalse(LowS(new byte[64]));
        Assert.IsFalse(LowS(new byte[63]));
        Assert.IsFalse(LowS(Scalars(BigInteger.Zero, BigInteger.One)));
        Assert.IsFalse(LowS(Scalars(Order, BigInteger.One)));
        Assert.IsFalse(LowS(Scalars(BigInteger.One, BigInteger.Zero)));
        Assert.IsTrue(LowS(Scalars(BigInteger.One, Order / 2)));
        Assert.IsFalse(LowS(Scalars(BigInteger.One, Order / 2 + 1)));
    }

    [TestMethod]
    public void LeasePayloadAndSignature()
    {
        using JsonDocument document = Read("protocol.json");
        JsonElement vector = document.RootElement, claims = vector.GetProperty("claims");
        JsonElement body = vector.GetProperty("body"), proof = vector.GetProperty("proof");
        Assert.AreEqual(1L, claims.GetProperty("version").GetInt64());
        Assert.AreEqual("device-lease", Value(claims, "purpose"));
        Assert.AreEqual(Value(body, "binding_id"), Value(claims, "binding-id"));
        Assert.AreEqual(body.GetProperty("generation").GetInt64(), claims.GetProperty("generation").GetInt64());
        Assert.AreEqual(Value(body, "operation_id"), Value(claims, "operation-id"));
        Assert.AreEqual(Value(proof, "key_id"), Value(claims, "device-key-id"));
        var payload = new StringBuilder();
        foreach (string field in new[] { "version", "purpose", "key-id", "issuer", "audience", "project",
            "feature", "license-fingerprint", "binding-id", "device-key-id", "generation", "revocation-seq",
            "lease-id", "operation-id", "issued-at", "renew-after", "expires-at" })
        {
            JsonElement item = claims.GetProperty(field);
            payload.Append(field).Append('=').Append(item.ValueKind == JsonValueKind.String
                ? Encoded(claims, field) : item.GetInt64().ToString(CultureInfo.InvariantCulture)).Append('\n');
        }
        Assert.AreEqual(Value(vector, "lease_payload_hex"), Hex(Bytes(payload.ToString())));
        byte[] input = Bytes("lccdl1." + payload);
        Assert.AreEqual(Value(vector, "lease_signing_input_hex"), Hex(input));
        string[] token = Value(vector, "token").Split('.');
        Assert.AreEqual(3, token.Length);
        Assert.AreEqual("lccdl1", token[0]);
        CollectionAssert.AreEqual(Bytes(payload.ToString()), Decode(token[1]));
        byte[] der = Decode(Value(vector, "lease_signer_spki"));
        Assert.AreEqual(Value(claims, "key-id"), "sha256:" + Hash(der));
        using RSA key = RSA.Create();
        key.ImportSubjectPublicKeyInfo(der, out int consumed);
        Assert.AreEqual(der.Length, consumed);
        Assert.AreEqual(3072, key.KeySize);
        CollectionAssert.AreEqual(der, key.ExportSubjectPublicKeyInfo());
        Assert.AreEqual(422, der.Length);
        CollectionAssert.AreEqual(new byte[] { 1, 0, 1 }, key.ExportParameters(false).Exponent!);
        byte[] signature = Decode(token[2]);
        Assert.AreEqual(384, signature.Length);
        Assert.IsTrue(key.VerifyData(input, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
        Assert.IsFalse(key.VerifyData(Bytes("lccoa1." + payload), signature, HashAlgorithmName.SHA256,
            RSASignaturePadding.Pkcs1), "Wrong envelope");
        input[input.Length - 2] ^= 1;
        Assert.IsFalse(key.VerifyData(input, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1), "Changed expiry");
    }

    [TestMethod]
    public void EnrollmentComparison()
    {
        using JsonDocument document = Read("enrollment_comparison.json");
        JsonElement vector = document.RootElement, values = vector.GetProperty("input");
        var input = new StringBuilder("lcc-device-enrollment-comparison-v1\n");
        foreach (string field in new[] { "attempt_handle", "client_id", "project", "key_id", "redirect_uri",
            "state", "code_challenge" }) input.Append(Encoded(values, field)).Append('\n');
        Assert.AreEqual(Value(vector, "input_hex"), Hex(Bytes(input.ToString())));
        string digest = Hash(Bytes(input.ToString()));
        Assert.AreEqual(Value(vector, "sha256_hex"), digest);
        string display = digest.Substring(0, 12).ToUpperInvariant();
        Assert.AreEqual(Value(vector, "comparison_code"), display.Substring(0, 4) + "-"
            + display.Substring(4, 4) + "-" + display.Substring(8));
    }

    private static bool VerifyProof(ECDsa key, byte[] input, byte[] signature) =>
        key.VerifyData(input, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
    private static bool LowS(byte[] signature)
    {
        if (signature.Length != 64) return false;
        var r = new BigInteger(signature.AsSpan(0, 32), true, true);
        var s = new BigInteger(signature.AsSpan(32, 32), true, true);
        return r > 0 && r < Order && s > 0 && s <= Order / 2;
    }
    private static byte[] Scalars(BigInteger r, BigInteger s)
    {
        byte[] result = new byte[64], first = r.ToByteArray(true, true), second = s.ToByteArray(true, true);
        first.CopyTo(result, 32 - first.Length);
        second.CopyTo(result, 64 - second.Length);
        return result;
    }
    private static JsonDocument Read(string filename) => JsonDocument.Parse(File.ReadAllText(
        Path.Combine(GoldenVectors.VectorsDir, "device_bound", "v1", filename)));
    private static string Value(JsonElement value, string field) => value.GetProperty(field).GetString()!;
    private static string Encoded(JsonElement value, string field) => B64(Bytes(Value(value, field)));
    private static byte[] Bytes(string value) => Encoding.UTF8.GetBytes(value);
    private static string Hex(byte[] value) => Convert.ToHexString(value).ToLowerInvariant();
    private static string Hash(byte[] value) => Hex(SHA256.HashData(value));
    private static string B64(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static byte[] Decode(string value)
    {
        byte[] result = Convert.FromBase64String(value.Replace('-', '+').Replace('_', '/')
            + new string('=', (4 - value.Length % 4) % 4));
        Assert.AreEqual(value, B64(result), "Canonical base64url");
        return result;
    }
}
