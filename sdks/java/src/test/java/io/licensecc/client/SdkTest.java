package io.licensecc.client;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.interfaces.RSAPublicKey;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.Map;

public final class SdkTest {
    private SdkTest() {}

    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]).toAbsolutePath().normalize();
        configGolden(root);
        configKeyFloor(root);
        failClosedParsing();
        DeviceBoundVectorsTest.run(root);
        DeviceBoundAdapterTest.run();
        FeatureSessionAdapterTest.run();
        System.out.println("Java SDK tests passed");
    }

    private static void configGolden(Path root) throws IOException {
        Path vectors = root.resolve("test/vectors/config_attestation");
        String token = text(vectors.resolve("golden.token"));
        TrustedPublicKey key = TrustedPublicKey.fromHex(text(vectors.resolve("golden.public_key.pkcs1.der.hex")));
        var expected = new ConfigAttestation.Expected(Files.readAllBytes(vectors.resolve("golden.config")),
                "DEFAULT", "EXPORT", "a".repeat(64), "", BigInteger.valueOf(9), BigInteger.valueOf(1500));
        VerificationResult<ConfigAttestation.Claims> result = ConfigAttestation.verify(token, expected, List.of(key));
        check(result.ok(), "config golden verifies");
        check(result.claims().configId().equals("app-config"), "config claims parse");

        byte[] altered = "different".getBytes(StandardCharsets.UTF_8);
        var mismatch = new ConfigAttestation.Expected(altered, "DEFAULT", "EXPORT", "a".repeat(64), "",
                BigInteger.ZERO, BigInteger.valueOf(1500));
        VerificationResult<ConfigAttestation.Claims> rejected = ConfigAttestation.verify(token, mismatch, List.of(key));
        check(!rejected.ok() && rejected.code() == RejectionCode.CONFIG_HASH_MISMATCH, "config hash rejects");

        // The golden payload and signature under another envelope prefix: a valid signature
        // cannot make a token of another kind acceptable as a config token.
        String[] parts = token.split("\\.", -1);
        check(parts.length == 3, "golden token has three parts");
        VerificationResult<ConfigAttestation.Claims> otherPrefix =
                ConfigAttestation.verify("lccoa1." + parts[1] + "." + parts[2], expected, List.of(key));
        check(!otherPrefix.ok() && otherPrefix.code() == RejectionCode.PREFIX_MISMATCH,
                "another envelope prefix rejects");
    }

    // Every verifier applies the same 3072-bit floor, so even a correctly signed token from a
    // trusted key below it is refused; the same re-signing with a 3072-bit key verifies.
    private static void configKeyFloor(Path root) throws IOException, GeneralSecurityException {
        Path vectors = root.resolve("test/vectors/config_attestation");
        String payloadB64 = text(vectors.resolve("golden.token")).split("\\.", -1)[1];
        String goldenKeyId = text(vectors.resolve("golden.key_id"));
        var expected = new ConfigAttestation.Expected(Files.readAllBytes(vectors.resolve("golden.config")),
                "DEFAULT", "EXPORT", "a".repeat(64), "", BigInteger.valueOf(9), BigInteger.valueOf(1500));
        for (int bits : new int[] {1024, 2048}) {
            VerificationResult<ConfigAttestation.Claims> weak = verifyResigned(payloadB64, goldenKeyId, bits, expected);
            check(!weak.ok() && weak.code() == RejectionCode.KEY_TOO_WEAK, bits + "-bit trusted key rejects");
        }
        check(verifyResigned(payloadB64, goldenKeyId, 3072, expected).ok(), "3072-bit trusted key verifies");
    }

    // The golden payload, re-keyed to a fresh trusted key of the given size and signed by it.
    private static VerificationResult<ConfigAttestation.Claims> verifyResigned(String payloadB64, String goldenKeyId,
            int bits, ConfigAttestation.Expected expected) throws GeneralSecurityException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(bits);
        KeyPair pair = generator.generateKeyPair();
        RSAPublicKey publicKey = (RSAPublicKey) pair.getPublic();
        TrustedPublicKey trusted = new TrustedPublicKey(
                der(0x30, concat(der(0x02, publicKey.getModulus().toByteArray()),
                        der(0x02, publicKey.getPublicExponent().toByteArray()))));
        String payloadText = new String(Base64.getDecoder().decode(payloadB64), StandardCharsets.UTF_8);
        byte[] payload = payloadText.replace(goldenKeyId, trusted.keyId()).getBytes(StandardCharsets.UTF_8);
        check(!payloadText.equals(new String(payload, StandardCharsets.UTF_8)), "payload re-keyed");
        Signature signer = Signature.getInstance("SHA256withRSA");
        signer.initSign(pair.getPrivate());
        signer.update(payload);
        Base64.Encoder encoder = Base64.getEncoder();
        String token = "lcccfg1." + encoder.encodeToString(payload) + "." + encoder.encodeToString(signer.sign());
        return ConfigAttestation.verify(token, expected, List.of(trusted));
    }

    private static byte[] der(int tag, byte[] content) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(tag);
        if (content.length < 0x80) {
            out.write(content.length);
        } else {
            byte[] length = BigInteger.valueOf(content.length).toByteArray();
            int skip = length[0] == 0 ? 1 : 0;
            out.write(0x80 | (length.length - skip));
            out.write(length, skip, length.length - skip);
        }
        out.write(content, 0, content.length);
        return out.toByteArray();
    }

    private static byte[] concat(byte[] first, byte[] second) {
        byte[] joined = Arrays.copyOf(first, first.length + second.length);
        System.arraycopy(second, 0, joined, first.length, second.length);
        return joined;
    }

    private static void failClosedParsing() {
        expectFailure(() -> Json.parse("{\"value\":\"\ud800\"}"), "raw unpaired surrogate rejects");
        expectFailure(() -> Json.serialize(Map.of("value", "\udc00")), "serialized unpaired surrogate rejects");
        check(Json.serialize(Map.of("value", "🚀")).contains("🚀"),
                "valid surrogate pair serializes");
    }

    private static String text(Path path) throws IOException {
        return Files.readString(path, StandardCharsets.UTF_8).strip();
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static void expectFailure(Runnable operation, String message) {
        try {
            operation.run();
        } catch (IllegalArgumentException expected) {
            return;
        }
        throw new AssertionError(message);
    }
}
