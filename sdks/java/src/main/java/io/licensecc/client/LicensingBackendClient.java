package io.licensecc.client;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** Thin JDK-only HTTP client for Licensecc's documented client-facing Worker routes. */
public final class LicensingBackendClient {
    public static final String VERSION = "0.1.0-rc.1";
    private static final Set<Integer> RETRYABLE = Set.of(429, 502, 503, 504);

    private final HttpClient http;
    private final URI baseUri;
    private final Duration timeout;
    private final int maxRetries;
    private final Duration retryBackoff;
    private final String accountToken;

    public LicensingBackendClient(URI baseUri) {
        this(HttpClient.newHttpClient(), baseUri, null, Duration.ofSeconds(15), 2, Duration.ofMillis(500));
    }

    public LicensingBackendClient(HttpClient http, URI baseUri, String accountToken,
                                  Duration timeout, int maxRetries, Duration retryBackoff) {
        if (http == null || baseUri == null || !baseUri.isAbsolute()) {
            throw new IllegalArgumentException("absolute base URI and HTTP client are required");
        }
        this.http = http;
        String normalized = baseUri.toString().replaceAll("/+$", "");
        this.baseUri = URI.create(normalized + "/");
        this.accountToken = accountToken;
        this.timeout = timeout == null ? Duration.ofSeconds(15) : timeout;
        this.maxRetries = Math.max(0, maxRetries);
        this.retryBackoff = retryBackoff == null || retryBackoff.isNegative() ? Duration.ZERO : retryBackoff;
    }

    public BackendResponse verify(Map<String, Object> body) { return post("v1/verify", body, false, true); }
    public BackendResponse activate(Map<String, Object> body) { return post("v1/activate", body, true, true); }
    public BackendResponse renew(Map<String, Object> body) { return post("v1/renew", body, true, true); }
    public BackendResponse checkout(Map<String, Object> body) { return post("v1/checkout", body, true, true); }
    public BackendResponse heartbeat(Map<String, Object> body) { return post("v1/heartbeat", body, true, true); }
    public BackendResponse release(Map<String, Object> body) { return post("v1/release", body, true, true); }

    /** Metering deliberately never retries: a lost response must not duplicate a counter mutation. */
    public BackendResponse meter(Map<String, Object> body) { return post("v1/meter", body, true, false); }

    public BackendResponse report(String project, String feature, String fingerprint,
                                  Long fromEpoch, Long toEpoch) {
        LinkedHashMap<String, Object> query = new LinkedHashMap<>();
        query.put("project", project);
        query.put("feature", feature);
        query.put("license_fingerprint", fingerprint);
        if (fromEpoch != null) query.put("from", fromEpoch);
        if (toEpoch != null) query.put("to", toEpoch);
        StringBuilder target = new StringBuilder("v1/admin/report?");
        boolean first = true;
        for (Map.Entry<String, Object> entry : query.entrySet()) {
            if (!first) target.append('&');
            first = false;
            target.append(url(entry.getKey())).append('=').append(url(String.valueOf(entry.getValue())));
        }
        return send(HttpRequest.newBuilder(baseUri.resolve(target.toString())).GET(), true, true);
    }

    private BackendResponse post(String path, Map<String, Object> body, boolean bearer, boolean retry) {
        String payload = Json.serialize(body == null ? Map.of() : body);
        HttpRequest.Builder request = HttpRequest.newBuilder(baseUri.resolve(path))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8));
        return send(request, bearer, retry);
    }

    private BackendResponse send(HttpRequest.Builder builder, boolean bearer, boolean retry) {
        builder.timeout(timeout).header("Accept", "application/json")
                .header("User-Agent", "licensecc-java-sdk/" + VERSION);
        if (bearer && accountToken != null && !accountToken.isEmpty()) {
            builder.header("Authorization", "Bearer " + accountToken);
        }
        int attempt = 0;
        while (true) {
            try {
                HttpResponse<String> response = http.send(builder.build(),
                        HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
                if (retry && RETRYABLE.contains(response.statusCode()) && attempt < maxRetries) {
                    sleep(delay(response, attempt++));
                    continue;
                }
                return parseResponse(response.statusCode(), response.body());
            } catch (IOException exception) {
                if (!retry || attempt >= maxRetries) return transportFailure(exception);
                sleep(backoff(attempt++));
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                return transportFailure(exception);
            } catch (RuntimeException exception) {
                return transportFailure(exception);
            }
        }
    }

    @SuppressWarnings("unchecked")
    static BackendResponse parseResponse(int status, String body) {
        try {
            Object decoded = Json.parse(body == null || body.isEmpty() ? "{}" : body);
            if (!(decoded instanceof Map<?, ?> raw)) throw new IllegalArgumentException("response is not an object");
            LinkedHashMap<String, Object> fields = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : raw.entrySet()) fields.put((String) entry.getKey(), entry.getValue());
            boolean ok = fields.get("ok") == Boolean.TRUE;
            String code = fields.get("code") instanceof String text ? text : null;
            return new BackendResponse(status, ok, code, fields, body, null);
        } catch (RuntimeException exception) {
            return new BackendResponse(status, false, "malformed_response", Map.of(), body,
                    "malformed JSON response");
        }
    }

    private BackendResponse transportFailure(Exception exception) {
        return new BackendResponse(0, false, null, Map.of(), "", exception.getMessage());
    }

    private Duration delay(HttpResponse<?> response, int attempt) {
        String retryAfter = response.headers().firstValue("Retry-After").orElse("").strip();
        if (retryAfter.matches("[0-9]+")) {
            try { return Duration.ofSeconds(Long.parseLong(retryAfter)); } catch (NumberFormatException ignored) { }
        }
        return backoff(attempt);
    }

    private Duration backoff(int attempt) {
        long factor = 1L << Math.min(attempt, 30);
        try { return retryBackoff.multipliedBy(factor); } catch (ArithmeticException ignored) { return Duration.ofDays(1); }
    }

    private static void sleep(Duration duration) {
        if (duration.isZero()) return;
        try {
            Thread.sleep(duration.toMillis());
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
        }
    }

    private static String url(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }
}
