import { BOUND_CLEANUP_MAX_ROWS, purgeExpiredBoundApprovals, purgeExpiredBoundEphemera,
  expireBoundRecovery, purgeExpiredBoundLeases, measureBoundCleanupBacklog } from "../device/bound_cleanup.mjs";
import type { D1DatabaseLike } from "../env.js";
import { logEvent } from "../observability/index.js";

export async function runBoundDeviceCleanup(db: D1DatabaseLike): Promise<void> {
  const jobs: Array<{ source: string; run: () => Promise<Record<string, number>> }> = [
    { source: "approval", run: () => purgeExpiredBoundApprovals(db) },
    { source: "ephemera", run: () => purgeExpiredBoundEphemera(db) },
    { source: "recovery", run: () => expireBoundRecovery(db) },
    { source: "lease", run: () => purgeExpiredBoundLeases(db) },
  ];
  for (const job of jobs) {
    try {
      const result = await job.run();
      for (const [target, affected_rows] of Object.entries(result)) {
        const limit_reached = affected_rows >= BOUND_CLEANUP_MAX_ROWS;
        // A full sweep is a pressure signal, not proof that another row exists.
        logEvent(limit_reached ? "warn" : "info",
          limit_reached ? "device.cleanup_limit_reached" : "device.cleanup_completed",
          { source: job.source, target, affected_rows, limit_reached });
      }
    } catch {
      // Keep existing event names and never disclose the database exception.
      logEvent("warn", `device.${job.source}_cleanup_failed`, {});
    }
  }
  try {
    const observations = await measureBoundCleanupBacklog(db);
    for (const observation of observations) {
      logEvent(observation.backlog_present ? "warn" : "info", "device.cleanup_backlog", observation);
    }
  } catch {
    // Unknown measurement is not an empty backlog. Keep scheduler jobs running.
    logEvent("warn", "device.cleanup_backlog_failed", {});
  }
}
