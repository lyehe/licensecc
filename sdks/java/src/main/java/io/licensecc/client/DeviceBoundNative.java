package io.licensecc.client;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;

final class DeviceBoundNative implements DeviceBoundApi {
    private static Path loadedPath;
    private static boolean ready;
    private DeviceBoundNative() { }

    static synchronized DeviceBoundNative load(Path path) throws IOException {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        boolean windows = os.startsWith("windows");
        if ((!windows && !os.startsWith("linux"))
                || !"64".equals(System.getProperty("sun.arch.data.model"))) {
            throw new UnsupportedOperationException("The device-bound adapter requires 64-bit Windows or Linux Java");
        }
        if (!path.isAbsolute()) throw new IllegalArgumentException("An application-owned absolute native library path is required");
        Path canonical = path.toRealPath();
        if (!Files.isRegularFile(canonical) || !canonical.toString().toLowerCase(Locale.ROOT).endsWith(windows ? ".dll" : ".so")) {
            throw new IllegalArgumentException("Expected a regular JNI library (.dll on Windows, .so on Linux)");
        }
        if (loadedPath != null) {
            if (!ready || !loadedPath.equals(canonical)) throw new IllegalStateException("JNI library is already pinned or failed to initialize");
        } else {
            // JVM owns library lifetime. Never fall back to PATH, extract a DLL, or switch implementations.
            loadedPath = canonical;
            System.load(canonical.toString());
            if (version() != 1) throw new UnsatisfiedLinkError("Incompatible Licensecc JNI protocol");
            ready = true;
        }
        return new DeviceBoundNative();
    }

    private static native int version();
    private static native void openNative(byte[][] fields, byte[][] keys, boolean[] retired, boolean resume, long[] result);
    private static native void invokeNative(long handle, int operation, long[] result);
    private static native void prepareNative(long handle, long[] result, byte[] comparison);
    private static native int simpleNative(long handle, int operation, int waitMilliseconds);
    private static native void closeNative(long handle);
    @Override public void open(DeviceBoundConfiguration.Encoded configuration, boolean resume, long[] result) {
        openNative(configuration.fields(), configuration.keys(), configuration.retired(), resume, result);
    }
    @Override public void invoke(long handle, int operation, long[] result) { invokeNative(handle, operation, result); }
    @Override public void prepare(long handle, long[] result, byte[] comparison) { prepareNative(handle, result, comparison); }
    @Override public int simple(long handle, int operation, int waitMilliseconds) { return simpleNative(handle, operation, waitMilliseconds); }
    @Override public void close(long handle) { closeNative(handle); }
}
