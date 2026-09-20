package io.licensecc.client;

import java.math.BigInteger;
import java.nio.file.Path;

/** Separate JVM: an intentionally synthetic native owner tests JNI, never TPM behavior. */
final class DeviceBoundFixtureTest {
    private DeviceBoundFixtureTest() { }
    private static native int control(int value);
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
    public static void main(String[] args) throws Exception {
        var library = new DeviceBoundLibrary(Path.of(args[0]));
        var configuration = DeviceBoundAdapterTest.configuration("\uD83D\uDE80");
        for (int mode = 1; mode <= 3; mode++) {
            control(mode);
            try {
                library.openEnrollment(configuration);
                throw new AssertionError("Expected publication/layout failure");
            } catch (OutOfMemoryError error) {
                check(mode != 3 && error.getMessage().contains("synthetic"), "publication fault reached JVM");
            } catch (IllegalStateException error) { check(mode == 3, "layout fault reached JVM"); }
            check(control(-1) == 1, "native handle closed exactly once on failed publication or validation");
        }
        control(0);
        try (var client = library.openResume(configuration).client()) {
            check(control(-2) == 10, "native resume routing");
            var calls = java.util.List.<java.util.function.Supplier<DeviceBoundClient.Outcome>>of(client::activate,
                client::renew, client::authorize, client::saveCheckpoint, client::abandonPending);
            for (int i = 0; i < calls.size(); i++) {
                var result = calls.get(i).get();
                check(control(-2) == i && result.code() == DeviceBoundClient.Result.OK && result.renewalDue()
                    && result.checkpointResult() == DeviceBoundClient.CheckpointResult.COMMIT_UNKNOWN
                    && result.effectiveTime().equals(new BigInteger("18446744073709551615")), "JNI dispatch and independent unsigned outcome");
            }
            check(client.prepare().view().comparisonCode().equals("ABCD-1234-FFFF") && control(-2) == 5, "JNI comparison");
            client.launch(); check(control(-2) == 6, "JNI launch");
            client.poll(1000); check(control(-2) == 7, "JNI poll");
            client.cancel(); check(control(-2) == 8, "JNI cancel");
        }
        check(control(-1) == 1, "JNI normal close once");
        System.out.println("Synthetic JNI publication faults and native marshaling passed");
    }
}
