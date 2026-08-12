package io.licensecc.client;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

public final class SdkTest {
    private SdkTest() {}

    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]).toAbsolutePath().normalize();
        onlineGolden(root);
        configGolden(root);
        failClosedParsing(root);
        httpContract();
        System.out.println("Java SDK tests passed");
    }

    private static void onlineGolden(Path root) throws IOException {
        Path vectors = root.resolve("test/vectors/online_assertion");
        String token = text(vectors.resolve("golden.assertion"));
        TrustedPublicKey key = TrustedPublicKey.fromHex(text(vectors.resolve("golden.public_key.pkcs1.der.hex")));
        check(key.keyId().equals(text(vectors.resolve("golden.key_id"))), "online key id");
        var expected = new OnlineAssertion.Expected("DEFAULT", "EXPORT", "a".repeat(64), "b".repeat(64),
                "c".repeat(64), BigInteger.valueOf(42), BigInteger.valueOf(1100), true,
                BigInteger.valueOf(600), true);
        VerificationResult<OnlineAssertion.Claims> result = OnlineAssertion.verify(token, expected, List.of(key));
        check(result.ok() && !result.usedCache(), "online golden verifies");
        check(result.claims().revocationSequence().equals(BigInteger.valueOf(42)), "online claims parse");

        var wrongNonce = new OnlineAssertion.Expected("DEFAULT", "EXPORT", "a".repeat(64), "b".repeat(64),
                "d".repeat(64), BigInteger.ZERO, BigInteger.valueOf(1400), true,
                SignedToken.MAX_UINT64, true);
        VerificationResult<OnlineAssertion.Claims> cached = OnlineAssertion.verify(token, wrongNonce, List.of(key));
        check(cached.ok() && cached.usedCache(), "online cache fallback");
        VerificationResult<OnlineAssertion.Claims> retired = OnlineAssertion.verify(token, expected, List.of(key),
                Set.of(key.keyId()));
        check(!retired.ok() && retired.code() == RejectionCode.RETIRED_KEY_ID, "retired key rejects");
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
        Path vectors = root.resolve("test/vectors/online_assertion");
        String token = text(vectors.resolve("golden.assertion"));
        TrustedPublicKey key = TrustedPublicKey.fromHex(text(vectors.resolve("golden.public_key.pkcs1.der.hex")));
        var expected = OnlineAssertion.Expected.live("DEFAULT", "EXPORT", "a".repeat(64), "b".repeat(64), "c".repeat(64));
        VerificationResult<OnlineAssertion.Claims> malformed = OnlineAssertion.verify(token + ".extra", expected, List.of(key));
        check(!malformed.ok() && malformed.code() == RejectionCode.ENVELOPE_MALFORMED, "envelope fail closed");
        String tampered = token.substring(0, token.length() - 1) + (token.endsWith("A") ? "B" : "A");
        VerificationResult<OnlineAssertion.Claims> badSignature = OnlineAssertion.verify(tampered, expected, List.of(key));
        check(!badSignature.ok(), "tampered signature rejects");
        check(!LicensingBackendClient.parseResponse(200, "{\"ok\":\"true\"}").ok(), "non-boolean ok rejects");
        check(!LicensingBackendClient.parseResponse(200, "{\"ok\":true,\"ok\":false}").ok(), "duplicate JSON rejects");
        expectFailure(() -> Json.parse("{\"value\":\"\ud800\"}"), "raw unpaired surrogate rejects");
        expectFailure(() -> Json.serialize(Map.of("value", "\udc00")), "serialized unpaired surrogate rejects");
        check(Json.serialize(Map.of("value", "\ud83d\ude80")).contains("\ud83d\ude80"),
                "valid surrogate pair serializes");
    }

    private static void httpContract() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicInteger verifyCalls = new AtomicInteger();
        AtomicInteger meterCalls = new AtomicInteger();
        AtomicInteger reportCalls = new AtomicInteger();
        server.createContext("/v1/verify", exchange -> {
            int count = verifyCalls.incrementAndGet();
            respond(exchange, count == 1 ? 503 : 200, count == 1
                    ? "{\"ok\":false,\"code\":\"temporary\"}"
                    : "{\"ok\":true,\"code\":\"entitlement_ok\",\"assertion\":\"token\"}");
        });
        server.createContext("/v1/meter", exchange -> {
            meterCalls.incrementAndGet();
            respond(exchange, 503, "{\"ok\":false,\"code\":\"temporary\"}");
        });
        server.createContext("/v1/admin/report", exchange -> {
            reportCalls.incrementAndGet();
            check("Bearer secret".equals(exchange.getRequestHeaders().getFirst("Authorization")), "report bearer");
            check(exchange.getRequestURI().getQuery().contains("project=DEFAULT"), "report query");
            respond(exchange, 200, "{\"ok\":true,\"code\":\"report_ok\"}");
        });
        server.start();
        try {
            URI base = URI.create("http://127.0.0.1:" + server.getAddress().getPort());
            var client = new LicensingBackendClient(java.net.http.HttpClient.newHttpClient(), base, "secret",
                    Duration.ofSeconds(3), 2, Duration.ZERO);
            check(client.verify(Map.of("project", "DEFAULT")).ok() && verifyCalls.get() == 2,
                    "verify retries transient status");
            check(!client.meter(Map.of("units", 1)).ok() && meterCalls.get() == 1,
                    "meter never retries");
            check(client.report("DEFAULT", "EXPORT", "a".repeat(64), null, null).ok()
                    && reportCalls.get() == 1, "report route");
        } finally {
            server.stop(0);
        }
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
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
