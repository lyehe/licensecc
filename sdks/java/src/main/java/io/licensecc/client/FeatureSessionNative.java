package io.licensecc.client;

import java.io.IOException;
import java.nio.file.Path;

final class FeatureSessionNative implements FeatureSessionApi {
    static FeatureSessionNative load(Path path) throws IOException {
        DeviceBoundNative.load(path); // Reuse the pinned absolute-path loader and old ABI check.
        try {
            if (version() != 1) throw new UnsupportedOperationException("Incompatible feature-session JNI protocol");
        } catch (UnsatisfiedLinkError error) {
            throw new UnsupportedOperationException("This native bridge does not support feature sessions", error);
        }
        return new FeatureSessionNative();
    }
    private static native int version();
    private static native void openNative(byte[][] fields, byte[][] keys, boolean[] retired, long[] result);
    private static native void invokeNative(long handle, int operation, byte[] feature, long[] result);
    private static native void closeNative(long handle);
    @Override public void open(DeviceBoundConfiguration.Encoded configuration, long[] result) {
        openNative(configuration.fields(), configuration.keys(), configuration.retired(), result);
    }
    @Override public void invoke(long handle, int operation, byte[] feature, long[] result) {
        invokeNative(handle, operation, feature, result);
    }
    @Override public void close(long handle) { closeNative(handle); }
}
