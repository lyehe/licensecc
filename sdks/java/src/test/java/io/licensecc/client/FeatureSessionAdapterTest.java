package io.licensecc.client;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import io.licensecc.client.DeviceBoundClient.Result;

final class FeatureSessionAdapterTest {
    private FeatureSessionAdapterTest() { }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    private static void rejects(Class<? extends Throwable> type, Runnable action) {
        try { action.run(); } catch (Throwable error) {
            if (type.isInstance(error)) return;
            throw new AssertionError("Unexpected exception", error);
        }
        throw new AssertionError("Expected " + type.getName());
    }
    private static final class Fake implements FeatureSessionApi {
        final List<Long> closed = new ArrayList<>();
        final List<String> features = new ArrayList<>();
        long next = 1;
        long code;
        Runnable during = () -> { };
        @Override public void open(DeviceBoundConfiguration.Encoded configuration, long[] result) {
            long[] raw = {next++, 0, 1, 0, 0, 0, 0, 0, 0};
            System.arraycopy(raw, 0, result, 0, raw.length);
        }
        @Override public void invoke(long handle, int operation, byte[] feature, long[] result) {
            during.run();
            if (feature != null) features.add(new String(feature, StandardCharsets.US_ASCII));
            long[] raw = {code, 3, 0, 10, 1, 1000, 1450, -1};
            System.arraycopy(raw, 0, result, 0, raw.length);
        }
        @Override public void close(long handle) { closed.add(handle); }
    }
    static void run() throws Exception {
        var fake = new Fake();
        var library = new FeatureSessionLibrary(fake);
        for (String feature : List.of("BATCH_RUN", "EXPORT")) {
            var opened = library.open(DeviceBoundAdapterTest.configuration("desktop"));
            check(opened.outcome().state() == FeatureSession.State.READY, "open has no authority");
            try (var session = opened.session()) {
                check(session.start().checkpointResult() == DeviceBoundClient.CheckpointResult.COMMIT_UNKNOWN, "independent checkpoint");
                for (long code : new long[]{0, 6, 8, 14, 20}) {
                    fake.code = code;
                    var result = session.authorize(feature);
                    check(result.code() == DeviceBoundClient.decodeCode(code), "native result forwarded without cache");
                    check(result.expiresAt().equals(new BigInteger("18446744073709551615")), "unsigned time preserved");
                }
                for (String invalid : List.of("", "a".repeat(16), "é", "x\0y"))
                    rejects(IllegalArgumentException.class, () -> session.authorize(invalid));
                fake.during = () -> check(session.start().code() == Result.BUSY, "recursive calls are busy");
                session.renew(); fake.during = () -> { };
                session.stop();
            }
            rejects(IllegalStateException.class, () -> opened.session().start());
        }
        check(fake.closed.equals(List.of(1L, 2L)), "each owner closed exactly once");
        check(fake.features.containsAll(List.of("BATCH_RUN", "EXPORT")), "required feature forwarded");
        for (int index = 0; index < 5; ++index) {
            long[] raw = {0, 3, 0, 0, 0, 0, 0, 0}; raw[index] = 999;
            rejects(IllegalStateException.class, () -> FeatureSession.decode(raw, 0));
        }
        String path = System.getenv("LCC_TEST_DEVICE_BOUND_JNI_DLL");
        if (path != null && !path.isEmpty()) {
            var actual = new FeatureSessionLibrary(Path.of(path));
            var result = actual.open(DeviceBoundAdapterTest.configuration("desktop"));
            check(result.session() == null && result.outcome().code() == Result.INVALID_ARGUMENT, "installed JNI no provisioning");
            var nativeApi = FeatureSessionNative.load(Path.of(path));
            var encoded = DeviceBoundAdapterTest.configuration("desktop").encode();
            rejects(IllegalStateException.class, () -> nativeApi.open(encoded, new long[8]));
            rejects(IllegalStateException.class, () -> nativeApi.invoke(0, 0, null, new long[7]));
            rejects(IllegalStateException.class, () -> nativeApi.invoke(0, 4, null, new long[8]));
            rejects(IllegalStateException.class, () -> nativeApi.invoke(0, 4, new byte[]{0}, new long[8]));
            rejects(IllegalStateException.class, () -> nativeApi.invoke(0, 4, new byte[16], new long[8]));
            rejects(IllegalStateException.class, () -> nativeApi.invoke(0, 0, new byte[]{65}, new long[8]));
            for (int operation = 0; operation <= 4; ++operation) {
                long[] raw = FeatureSession.newOutcome(0);
                nativeApi.invoke(0, operation, operation == 4 ? new byte[]{65} : null, raw);
                check(FeatureSession.decode(raw, 0).code() == Result.INVALID_ARGUMENT, "null native owner rejected");
            }
            nativeApi.close(0);
        } else System.out.println("Feature-session installed JNI check skipped (LCC_TEST_DEVICE_BOUND_JNI_DLL unset)");
        System.out.println("Feature-session adapter checks passed");
    }
    public static void main(String[] args) throws Exception {
        check(args.length == 1, "older JNI fixture path");
        try { new FeatureSessionLibrary(Path.of(args[0])); throw new AssertionError("Expected unsupported optional API"); }
        catch (UnsupportedOperationException expected) { check(expected.getMessage().contains("does not support"), "explicit unsupported"); }
        new DeviceBoundLibrary(Path.of(args[0]));
        System.out.println("Older JNI remains usable after optional feature-session rejection");
    }
}
