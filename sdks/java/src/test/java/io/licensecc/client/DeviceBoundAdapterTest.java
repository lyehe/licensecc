package io.licensecc.client;

import java.lang.ref.WeakReference;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

final class DeviceBoundAdapterTest {
    private DeviceBoundAdapterTest() { }
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
    private static void rejects(Class<? extends Throwable> type, Runnable action) {
        try { action.run(); } catch (Throwable error) {
            if (type.isInstance(error)) return;
            throw new AssertionError("Wrong exception", error);
        }
        throw new AssertionError("Expected " + type.getName());
    }
    static DeviceBoundConfiguration configuration(String label) {
        return new DeviceBoundConfiguration("invalid APPLICATION", "https://backend.invalid", "https://portal.invalid/authorize",
            "issuer", "lease", "proof", "APP", "PRO", "desktop", label, "/callback",
            List.of(new DeviceBoundConfiguration.TrustedSigner(new byte[]{1}, false)));
    }
    private static final class Fake implements DeviceBoundApi {
        final AtomicInteger closes = new AtomicInteger();
        long[] opened = {73, 0, 0, 0, 0, 0};
        long[] invoked = {0, 0, 0, 1, -1};
        int operation = -1;
        int wait = -1;
        boolean resumed;
        Runnable during = () -> { };
        Runnable afterOpen = () -> { };
        byte[] comparison = "ABCD-1234-FFFF\0".getBytes(StandardCharsets.US_ASCII);
        @Override public void open(DeviceBoundConfiguration.Encoded configuration, boolean resume, long[] result) {
            resumed = resume;
            System.arraycopy(opened, 0, result, 0, opened.length);
            afterOpen.run();
        }
        @Override public void invoke(long handle, int op, long[] result) {
            check(handle == 73, "native handle"); operation = op; during.run();
            System.arraycopy(invoked, 0, result, 0, invoked.length);
        }
        @Override public void prepare(long handle, long[] result, byte[] text) {
            result[0] = 0; result[1] = -1;
            System.arraycopy(comparison, 0, text, 0, comparison.length);
        }
        @Override public int simple(long handle, int op, int milliseconds) { operation = op; wait = milliseconds; return 10; }
        @Override public void close(long handle) { check(handle == 73, "close owns original handle"); closes.incrementAndGet(); }
    }

    static void run() throws Exception {
        configurationBounds();
        operationsAndClose();
        failedOpenCleanup();
        malformedOutcomes();
        reentry();
        concurrentClose();
        cleaner();
        installed();
        System.out.println("Java device-bound adapter boundary tests passed");
    }
    private static void configurationBounds() {
        String astral = "\uD83D\uDE80";
        check(configuration(astral.repeat(80)).encode().fields()[9].length == 320, "UTF-8 byte bounds");
        rejects(IllegalArgumentException.class, () -> configuration(astral.repeat(81)));
        rejects(IllegalArgumentException.class, () -> configuration("bad\0label"));
        rejects(IllegalArgumentException.class, () -> configuration("bad\uD800"));
        rejects(IllegalArgumentException.class, () -> new DeviceBoundConfiguration.TrustedSigner(new byte[0], false));
        rejects(IllegalArgumentException.class, () -> new DeviceBoundConfiguration.TrustedSigner(new byte[513], false));
        var config = configuration("desktop");
        var first = config.encode(); first.fields()[0][0] = 0; first.keys()[0][0] = 9; first.retired()[0] = true;
        check(config.encode().fields()[0][0] != 0 && config.encode().keys()[0][0] == 1 && !config.encode().retired()[0], "defensive output copies");
        byte[] key = {4};
        var signer = new DeviceBoundConfiguration.TrustedSigner(key, false); key[0] = 99;
        var own = new DeviceBoundConfiguration("id", "https://b.invalid", "https://p.invalid/a", "i", "l", "p", "APP", "PRO", "c", "n", "/callback", List.of(signer));
        check(own.encode().keys()[0][0] == 4, "defensive input copy");
    }
    private static void operationsAndClose() {
        var fake = new Fake(); var library = new DeviceBoundLibrary(fake);
        var opened = library.openResume(configuration("desktop"));
        var client = opened.client();
        check(fake.resumed && opened.outcome().code() == DeviceBoundClient.Result.OK, "resume routing");
        check(client.activate().renewalDue() && fake.operation == 0, "activate routing");
        client.renew(); check(fake.operation == 1, "renew routing");
        check(client.authorize().effectiveTime().equals(new BigInteger("18446744073709551615")) && fake.operation == 2, "unsigned native time");
        client.saveCheckpoint(); check(fake.operation == 3, "save routing");
        client.abandonPending(); check(fake.operation == 4, "abandon routing");
        check(client.prepare().view().comparisonCode().equals("ABCD-1234-FFFF"), "comparison display");
        fake.comparison[14] = 1; rejects(IllegalStateException.class, client::prepare);
        fake.comparison[14] = 0; fake.comparison[0] = (byte) 255; rejects(IllegalStateException.class, client::prepare);
        client.launch(); check(fake.operation == 0, "launch routing");
        client.poll(1000); check(fake.operation == 1 && fake.wait == 1000, "poll bounds");
        rejects(IllegalArgumentException.class, () -> client.poll(-1));
        rejects(IllegalArgumentException.class, () -> client.poll(1001));
        client.cancel(); check(fake.operation == 2, "cancel routing");
        client.close(); client.close(); check(fake.closes.get() == 1, "close exactly once");
        rejects(IllegalStateException.class, client::authorize);
        rejects(IllegalStateException.class, client::prepare);
        rejects(IllegalStateException.class, client::launch);
    }
    private static void failedOpenCleanup() {
        for (long[] raw : new long[][]{{73, 8, 0, 0, 0, 0}, {73, 21, 0, 0, 0, 0}, {73, 0, 16, 0, 0, 0}, {73, 0, 0, 12, 0, 0}, {73, 0, 0, 0, 2, 0}}) {
            var fake = new Fake(); fake.opened = raw;
            rejects(IllegalStateException.class, () -> new DeviceBoundLibrary(fake).openEnrollment(configuration("desktop")));
            check(fake.closes.get() == 1, "malformed native open cleaned");
        }
        var failed = new Fake(); failed.opened = new long[]{0, 8, 0, 0, 0, 0};
        check(new DeviceBoundLibrary(failed).openEnrollment(configuration("desktop")).client() == null && failed.closes.get() == 0, "denied open has no client");
        var missing = new Fake(); missing.opened[0] = 0;
        rejects(IllegalStateException.class, () -> new DeviceBoundLibrary(missing).openEnrollment(configuration("desktop")));
        var allocation = new Fake(); allocation.afterOpen = () -> { throw new OutOfMemoryError("synthetic publication failure"); };
        rejects(OutOfMemoryError.class, () -> new DeviceBoundLibrary(allocation).openEnrollment(configuration("desktop")));
        check(allocation.closes.get() == 1, "publication exception cleaned");
    }
    private static void malformedOutcomes() {
        var fake = new Fake();
        try (var client = new DeviceBoundLibrary(fake).openEnrollment(configuration("desktop")).client()) {
            for (long[] raw : new long[][]{{}, {0}, {22, 0, 0, 0, 0}, {0, 15, 0, 0, 0}, {0, 0, -1, 0, 0}, {0, 0, 0, 2, 0}}) {
                fake.invoked = raw; rejects(IllegalStateException.class, client::renew);
                check(fake.closes.get() == 0, "failed result preserves recovery owner");
            }
            fake.invoked = new long[]{6, 255, 10, 0, 0};
            var retry = client.renew();
            check(retry.code() == DeviceBoundClient.Result.RETRY && retry.checkpointResult() == DeviceBoundClient.CheckpointResult.COMMIT_UNKNOWN, "independent outcomes");
        }
    }
    private static void reentry() {
        var fake = new Fake();
        try (var client = new DeviceBoundLibrary(fake).openEnrollment(configuration("desktop")).client()) {
            fake.during = () -> {
                check(client.authorize().code() == DeviceBoundClient.Result.BUSY && client.prepare().code() == DeviceBoundClient.Result.BUSY
                    && client.cancel() == DeviceBoundClient.Result.BUSY, "same-thread overlap rejected");
                rejects(IllegalStateException.class, client::close);
                check(fake.closes.get() == 0, "reentrant close cannot free active handle");
            };
            client.renew();
        }
        check(fake.closes.get() == 1, "reentrant rejection preserves cleanup");
    }
    private static void concurrentClose() throws Exception {
        var fake = new Fake(); var client = new DeviceBoundLibrary(fake).openEnrollment(configuration("desktop")).client();
        var entered = new CountDownLatch(1); var release = new CountDownLatch(1); var closing = new CountDownLatch(2);
        fake.during = () -> { entered.countDown(); await(release); };
        var executor = Executors.newFixedThreadPool(3);
        try {
            var call = executor.submit(client::renew);
            check(entered.await(5, TimeUnit.SECONDS), "native operation entered");
            check(client.authorize().code() == DeviceBoundClient.Result.BUSY, "concurrent overlap busy");
            var close1 = executor.submit(() -> { closing.countDown(); client.close(); });
            var close2 = executor.submit(() -> { closing.countDown(); client.close(); });
            check(closing.await(5, TimeUnit.SECONDS), "concurrent closes started");
            System.gc(); check(fake.closes.get() == 0 && !close1.isDone() && !close2.isDone(), "close and GC preserve admitted owner");
            release.countDown(); call.get(5, TimeUnit.SECONDS); close1.get(5, TimeUnit.SECONDS); close2.get(5, TimeUnit.SECONDS);
            check(fake.closes.get() == 1, "concurrent closes exactly once");
        } finally { release.countDown(); executor.shutdownNow(); client.close(); }
    }
    private static void await(CountDownLatch latch) {
        try { if (!latch.await(5, TimeUnit.SECONDS)) throw new AssertionError("Timed out waiting for test barrier"); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new AssertionError(error); }
    }
    private static WeakReference<DeviceBoundClient> orphan(Fake fake) {
        return new WeakReference<>(new DeviceBoundLibrary(fake).openEnrollment(configuration("desktop")).client());
    }
    private static void cleaner() throws Exception {
        var fake = new Fake(); var weak = orphan(fake);
        for (int i = 0; i < 100 && fake.closes.get() == 0; i++) { System.gc(); Thread.sleep(20); }
        check(weak.get() == null && fake.closes.get() == 1, "unreachable owner cleaned exactly once");
    }
    private static void installed() throws Exception {
        String dll = System.getenv("LCC_TEST_DEVICE_BOUND_JNI_DLL");
        if (dll == null || dll.isBlank()) { System.out.println("Installed JNI test not requested (set LCC_TEST_DEVICE_BOUND_JNI_DLL)"); return; }
        var library = new DeviceBoundLibrary(Path.of(dll));
        for (boolean resume : new boolean[]{false, true}) {
            var opened = resume ? library.openResume(configuration("desktop")) : library.openEnrollment(configuration("desktop"));
            check(opened.client() == null && opened.outcome().code() == DeviceBoundClient.Result.INVALID_ARGUMENT, "installed native rejects configuration before provisioning");
        }
        check(new DeviceBoundLibrary(Path.of(dll)) != null, "same library path reusable");
        Path alternative = Path.of("build/java-sdk/alternative-jni" + (System.getProperty("os.name").startsWith("Windows") ? ".dll" : ".so")).toAbsolutePath();
        Files.copy(Path.of(dll), alternative);
        try { new DeviceBoundLibrary(alternative); throw new AssertionError("Expected second-path rejection"); }
        catch (IllegalStateException expected) { check(expected.getMessage().contains("pinned"), "second DLL path rejected before loading"); }
        String bad = System.getenv("LCC_TEST_BAD_JNI_DLL");
        if (bad == null || bad.isBlank()) throw new AssertionError("Installed JNI gate requires incompatible-probe DLL");
        var process = new ProcessBuilder(Path.of(System.getProperty("java.home"), System.getProperty("os.name").startsWith("Windows") ? "bin/java.exe" : "bin/java").toString(), "-Xcheck:jni",
            "-cp", System.getProperty("java.class.path"), DeviceBoundAdapterTest.class.getName(), "bad-version", bad, dll).inheritIO().start();
        if (!process.waitFor(15, TimeUnit.SECONDS)) { process.destroyForcibly(); throw new AssertionError("Loader subprocess timed out"); }
        check(process.exitValue() == 0, "sticky failed-probe subprocess");
        String fixture = System.getenv("LCC_TEST_JNI_FIXTURE_DLL");
        if (fixture == null || fixture.isBlank()) throw new AssertionError("Installed JNI gate requires native fault fixture");
        var faultProcess = new ProcessBuilder(Path.of(System.getProperty("java.home"), System.getProperty("os.name").startsWith("Windows") ? "bin/java.exe" : "bin/java").toString(), "-Xcheck:jni",
            "-cp", System.getProperty("java.class.path"), DeviceBoundFixtureTest.class.getName(), fixture).inheritIO().start();
        if (!faultProcess.waitFor(15, TimeUnit.SECONDS)) { faultProcess.destroyForcibly(); throw new AssertionError("JNI fixture subprocess timed out"); }
        check(faultProcess.exitValue() == 0, "JNI fault fixture subprocess");
        var open = DeviceBoundNative.class.getDeclaredMethod("openNative", byte[][].class, byte[][].class, boolean[].class, boolean.class, long[].class);
        open.setAccessible(true);
        for (int mutation = 0; mutation < 12; mutation++) {
            var config = configuration("desktop").encode();
            byte[][] fields = config.fields(); byte[][] keys = config.keys(); boolean[] retired = config.retired(); long[] result = new long[6];
            Arrays.fill(result, 99);
            if (mutation == 0) fields = new byte[0][];
            if (mutation == 1) fields[0] = null;
            if (mutation == 2) fields[0] = new byte[]{0};
            if (mutation == 3) fields[0] = new byte[129];
            if (mutation == 4) keys[0] = new byte[513];
            if (mutation == 5) retired = new boolean[0];
            if (mutation == 6) fields = null;
            if (mutation == 7) keys = null;
            if (mutation == 8) retired = null;
            if (mutation == 9) keys = new byte[0][];
            if (mutation == 10) keys[0] = null;
            if (mutation == 11) result = new long[7];
            try { open.invoke(null, fields, keys, retired, false, result); throw new AssertionError("Expected JNI rejection"); }
            catch (java.lang.reflect.InvocationTargetException error) { check(error.getCause() instanceof IllegalStateException, "JNI shape rejection"); }
            long sentinel = mutation == 11 ? 0 : 99;
            check(Arrays.stream(result).allMatch(value -> value == sentinel), "invalid JNI input made no admission/output");
        }
        System.out.println("Installed JNI no-effect and malformed-input checks passed under -Xcheck:jni");
    }
    public static void main(String[] args) throws Exception {
        check(args.length == 3 && args[0].equals("bad-version"), "loader test arguments");
        try { new DeviceBoundLibrary(Path.of(args[1])); throw new AssertionError("Expected incompatible JNI version"); }
        catch (UnsatisfiedLinkError expected) { check(expected.getMessage().contains("Incompatible"), "version rejected"); }
        for (String dll : new String[]{args[1], args[2]}) {
            try { new DeviceBoundLibrary(Path.of(dll)); throw new AssertionError("Expected sticky loader failure"); }
            catch (IllegalStateException expected) { check(expected.getMessage().contains("failed"), "loader failure stays pinned"); }
        }
        System.out.println("JNI incompatible-version failure stays sticky");
    }
}
