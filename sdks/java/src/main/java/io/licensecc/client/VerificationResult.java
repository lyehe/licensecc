package io.licensecc.client;

/** A typed verifier outcome. Invalid untrusted input is rejected and never escapes as an exception. */
public record VerificationResult<T>(boolean ok, RejectionCode code, String detail, T claims, boolean usedCache) {
    public static <T> VerificationResult<T> accept(T claims, boolean usedCache) {
        return new VerificationResult<>(true, null, "", claims, usedCache);
    }

    public static <T> VerificationResult<T> reject(RejectionCode code, String detail) {
        String message = detail == null || detail.isEmpty() ? code.wireValue() : detail;
        return new VerificationResult<>(false, code, message, null, false);
    }
}
