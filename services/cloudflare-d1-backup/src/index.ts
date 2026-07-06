import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  type BackupEnvLike,
  type BackupResult,
  type R2BucketLike,
  backupConfigFromEnv,
  pollD1Export,
  pruneExpiredBackups,
  requireD1RestApiToken,
  saveD1ExportToR2,
  startD1Export,
} from "./core.js";
import {
  type BackupHttpEnv,
  type BackupTriggerParams,
  handleBackupRequest,
} from "./http.js";
import { type ScheduledControllerLike, startScheduledBackupWorkflow } from "./scheduled.js";

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env extends BackupEnvLike, BackupHttpEnv {
  D1_REST_API_TOKEN?: string;
  BACKUP_BUCKET: R2BucketLike;
}

export class D1BackupWorkflow extends WorkflowEntrypoint<Env, BackupTriggerParams> {
  async run(event: WorkflowEvent<BackupTriggerParams>, step: WorkflowStep): Promise<BackupResult> {
    const config = backupConfigFromEnv(this.env);
    const token = requireD1RestApiToken(this.env);
    const payload = event.payload ?? {};
    const trigger = event.schedule === undefined ? payload.trigger ?? "manual" : "scheduled";
    const started = await step.do(
      `start D1 export (${trigger})`,
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
      async () => startD1Export(fetch, config, token),
    );
    const saved = await step.do(
      "poll export and store SQL dump in R2",
      { retries: { limit: 20, delay: "30 seconds", backoff: "exponential" }, timeout: "15 minutes" },
      async () => {
        const ready = await pollD1Export(fetch, config, token, started.bookmark);
        return saveD1ExportToR2(this.env.BACKUP_BUCKET, fetch, config, started, ready, Date.now());
      },
    );
    const pruned = await step.do("prune expired R2 backups", async () => pruneExpiredBackups(this.env.BACKUP_BUCKET, config, Date.now()));
    return { ...saved, pruned_objects: pruned };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleBackupRequest(request, env);
    } catch (error) {
      console.error(JSON.stringify({ event: "backup.unhandled_error", error: error instanceof Error ? error.message : String(error) }));
      return new Response(JSON.stringify({ ok: false, code: "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
  async scheduled(controller: ScheduledControllerLike, env: Env, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(startScheduledBackupWorkflow(controller, env));
  },
};
