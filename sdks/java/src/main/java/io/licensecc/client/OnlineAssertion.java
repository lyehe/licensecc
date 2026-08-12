package io.licensecc.client;

import java.math.BigInteger;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Fail-closed verification of canonical {@code lccoa1} online assertions. */
public final class OnlineAssertion {
    private static final String PREFIX = "lccoa1";
    private static final String PURPOSE = "licensecc-online-assertion";
    private static final String VERSION = "1";
    private static final BigInteger FUTURE_SKEW = BigInteger.valueOf(300);
    private static final List<String> FIELDS = List.of(
            "purpose", "version", "alg", "key-id", "project", "feature",
            "license-fingerprint", "device-hash", "nonce", "status", "issued-at",
            "expires-at", "cache-until", "revocation-seq");

    private OnlineAssertion() {}

    public record Expected(String project, String feature, String licenseFingerprint,
                           String deviceHash, String nonce, BigInteger minRevocationSequence,
                           BigInteger now, boolean allowCache, BigInteger maxCacheSeconds,
                           boolean checkNonceBinding) {
        public Expected {
            deviceHash = deviceHash == null ? "" : deviceHash;
            nonce = nonce == null ? "" : nonce;
            minRevocationSequence = minRevocationSequence == null ? BigInteger.ZERO : minRevocationSequence;
            maxCacheSeconds = maxCacheSeconds == null ? SignedToken.MAX_UINT64 : maxCacheSeconds;
        }

        public static Expected live(String project, String feature, String fingerprint,
                                    String deviceHash, String nonce) {
            return new Expected(project, feature, fingerprint, deviceHash, nonce, BigInteger.ZERO,
                    null, false, SignedToken.MAX_UINT64, true);
        }
    }

    public record Claims(String purpose, String version, String algorithm, String keyId,
                         String project, String feature, String licenseFingerprint,
                         String deviceHash, String nonce, String status, BigInteger issuedAt,
                         BigInteger expiresAt, BigInteger cacheUntil, BigInteger revocationSequence) {}

    public static VerificationResult<Claims> verify(String token, Expected expected,
                                                     List<TrustedPublicKey> trustedKeys,
                                                     Set<String> retiredKeyIds) {
        if (expected == null) {
            return VerificationResult.reject(RejectionCode.BINDING_MISMATCH, "expected claims are required");
        }
        try {
            SignedToken.Envelope envelope = SignedToken.split(token, PREFIX);
            SignedToken.verifySignature(envelope, trustedKeys, 3072, retiredKeyIds);
            Map<String, String> values = SignedToken.parseFields(envelope.payloadText(), FIELDS, true);
            Claims claims = new Claims(values.get("purpose"), values.get("version"), values.get("alg"),
                    values.get("key-id"), values.get("project"), values.get("feature"),
                    values.get("license-fingerprint"), values.get("device-hash"), values.get("nonce"),
                    values.get("status"), SignedToken.parseUint64(values.get("issued-at")),
                    SignedToken.parseUint64(values.get("expires-at")),
                    SignedToken.parseUint64(values.get("cache-until")),
                    SignedToken.parseUint64(values.get("revocation-seq")));
            return validate(claims, expected);
        } catch (SignedToken.Failure failure) {
            return VerificationResult.reject(failure.code(), failure.getMessage());
        } catch (RuntimeException failure) {
            return VerificationResult.reject(RejectionCode.PAYLOAD_NOT_CANONICAL, "token verification failed");
        }
    }

    public static VerificationResult<Claims> verify(String token, Expected expected,
                                                     List<TrustedPublicKey> trustedKeys) {
        return verify(token, expected, trustedKeys, Set.of());
    }

    private static VerificationResult<Claims> validate(Claims claims, Expected expected) {
        BigInteger now = expected.now() == null ? BigInteger.valueOf(Instant.now().getEpochSecond()) : expected.now();
        if (!PURPOSE.equals(claims.purpose()) || !VERSION.equals(claims.version())
                || !SignedToken.ALGORITHM.equals(claims.algorithm())) {
            return VerificationResult.reject(RejectionCode.METADATA_MISMATCH, "metadata mismatch");
        }
        if (!"ok".equals(claims.status()) && !"denied".equals(claims.status())) {
            return VerificationResult.reject(RejectionCode.STATUS_UNSUPPORTED, "status unsupported");
        }
        if ("denied".equals(claims.status())) {
            return VerificationResult.reject(RejectionCode.STATUS_DENIED, "denied entitlement");
        }
        if (!equal(claims.project(), expected.project()) || !equal(claims.feature(), expected.feature())
                || !equal(claims.licenseFingerprint(), expected.licenseFingerprint())
                || !equal(claims.deviceHash(), expected.deviceHash())) {
            return VerificationResult.reject(RejectionCode.BINDING_MISMATCH, "request binding mismatch");
        }
        if (!SignedToken.isAsciiHex(claims.licenseFingerprint(), 64)
                || !SignedToken.isAsciiHex(claims.nonce(), 64)
                || (!claims.deviceHash().isEmpty() && !SignedToken.isAsciiHex(claims.deviceHash(), 64))) {
            return VerificationResult.reject(RejectionCode.HEX_FIELD_MALFORMED, "hex field malformed");
        }
        if (claims.issuedAt().compareTo(now.add(FUTURE_SKEW)) > 0
                || claims.expiresAt().compareTo(claims.issuedAt()) < 0
                || claims.cacheUntil().compareTo(claims.expiresAt()) < 0) {
            return VerificationResult.reject(RejectionCode.TIME_WINDOW_MALFORMED, "time window malformed");
        }
        if (claims.cacheUntil().subtract(claims.issuedAt()).compareTo(expected.maxCacheSeconds()) > 0) {
            return VerificationResult.reject(RejectionCode.CACHE_WINDOW_EXCEEDED, "cache window exceeds maximum");
        }
        if (claims.revocationSequence().compareTo(expected.minRevocationSequence()) < 0) {
            return VerificationResult.reject(RejectionCode.REVOCATION_BELOW_FLOOR, "revocation sequence below minimum");
        }
        if (expected.checkNonceBinding() && !equal(claims.nonce(), expected.nonce())) {
            if (expected.allowCache() && claims.cacheUntil().compareTo(now) >= 0) {
                return VerificationResult.accept(claims, true);
            }
            return VerificationResult.reject(RejectionCode.BINDING_MISMATCH, "request binding mismatch");
        }
        if (claims.expiresAt().compareTo(now) >= 0) {
            return VerificationResult.accept(claims, false);
        }
        if (expected.allowCache() && claims.cacheUntil().compareTo(now) >= 0) {
            return VerificationResult.accept(claims, true);
        }
        return VerificationResult.reject(RejectionCode.EXPIRED, expected.allowCache() ? "cache expired" : "expired");
    }

    private static boolean equal(String left, String right) {
        return left != null && left.equals(right);
    }
}
