package io.licensecc.client;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Objects;

/** Loads an application-owned JNI DLL. Its lifetime belongs to the JVM/class loader. */
public final class DeviceBoundLibrary {
    private final DeviceBoundApi api;
    public DeviceBoundLibrary(Path absoluteDllPath) throws IOException { this(DeviceBoundNative.load(absoluteDllPath)); }
    DeviceBoundLibrary(DeviceBoundApi api) { this.api = Objects.requireNonNull(api); }

    /** A client is present only when opening succeeded. Opening never grants protected access. */
    public record OpenResult(DeviceBoundClient client, DeviceBoundClient.Outcome outcome) { }
    public OpenResult openEnrollment(DeviceBoundConfiguration configuration) { return open(configuration, false); }
    public OpenResult openResume(DeviceBoundConfiguration configuration) { return open(configuration, true); }
    private OpenResult open(DeviceBoundConfiguration configuration, boolean resume) {
        long[] raw = DeviceBoundClient.newOutcome(1);
        var client = new DeviceBoundClient(api);
        boolean transferred = false;
        try {
            api.open(Objects.requireNonNull(configuration).encode(), resume, raw);
            client.adopt(raw[0]);
            raw[0] = 0;
            var outcome = DeviceBoundClient.decode(raw, 1);
            if (outcome.code() != DeviceBoundClient.Result.OK) {
                if (client.hasHandle()) throw new IllegalStateException("Failed native open returned a handle");
                return new OpenResult(null, outcome);
            }
            if (!client.hasHandle()) throw new IllegalStateException("Successful native open returned no handle");
            var result = new OpenResult(client, outcome);
            transferred = true;
            return result;
        } finally {
            if (raw[0] != 0) api.close(raw[0]);
            if (!transferred) client.close();
            java.lang.ref.Reference.reachabilityFence(client);
        }
    }
}
