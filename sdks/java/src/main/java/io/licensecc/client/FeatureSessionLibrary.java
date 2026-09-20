package io.licensecc.client;

import java.io.IOException;
import java.lang.ref.Reference;
import java.nio.file.Path;
import java.util.Objects;

/** Optional feature-session adapter. Existing DeviceBoundLibrary supports older JNI DLLs. */
public final class FeatureSessionLibrary {
    private final FeatureSessionApi api;
    public FeatureSessionLibrary(Path absoluteDllPath) throws IOException { this(FeatureSessionNative.load(absoluteDllPath)); }
    FeatureSessionLibrary(FeatureSessionApi api) { this.api = Objects.requireNonNull(api); }
    public record OpenResult(FeatureSession session, FeatureSession.Outcome outcome) { }
    public OpenResult open(DeviceBoundConfiguration configuration) {
        long[] raw = FeatureSession.newOutcome(1);
        var session = new FeatureSession(api);
        boolean transferred = false;
        try {
            api.open(Objects.requireNonNull(configuration).encode(), raw);
            session.adopt(raw[0]); raw[0] = 0;
            var result = FeatureSession.decode(raw, 1);
            if (result.code() != DeviceBoundClient.Result.OK) {
                if (session.hasHandle()) throw new IllegalStateException("Failed native open returned a handle");
                return new OpenResult(null, result);
            }
            if (!session.hasHandle()) throw new IllegalStateException("Successful native open returned no handle");
            var opened = new OpenResult(session, result);
            transferred = true;
            return opened;
        } finally {
            if (raw[0] != 0) api.close(raw[0]);
            if (!transferred) session.close();
            Reference.reachabilityFence(session);
        }
    }
}
