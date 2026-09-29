package io.licensecc.client;

import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

public final class SdkTest {
    private SdkTest() {}

    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]).toAbsolutePath().normalize();
        configGolden(root);
        failClosedParsing(root);
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
    }

    private static void failClosedParsing(Path root) throws IOException {
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
