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

// The generated declaration records the deployable's resource bindings. Its
// example-config literals are widened so backup validation keeps accepting
// real runtime values rather than only placeholder values.
type WidenWranglerStringBindings<Bindings extends object> = {
  [Binding in keyof Bindings]: Bindings[Binding] extends string ? string : Bindings[Binding];
};

type WithRuntimeNarrowing<Generated extends object, Runtime extends object> = Omit<Generated, keyof Runtime> & Runtime;

type IncompatibleGeneratedBindings<Generated extends object, Runtime extends object> = {
  [Binding in keyof Generated & keyof Runtime]: Generated[Binding] extends Runtime[Binding] ? never : Binding;
}[keyof Generated & keyof Runtime];

type AssertNoIncompatibleGeneratedBindings<Bindings extends never> = Bindings;

// Explicit keys make checked Wrangler binding drift a type error. Keep the
// service-local structural interfaces below for HTTP/Workflow test adapters.
type WranglerBindings = Pick<Cloudflare.Env,
  | "BACKUP_BUCKET"
  | "ACCOUNT_ID"
  | "DATABASE_ID"
  | "DATABASE_NAME"
  | "BACKUP_PREFIX"
  | "BACKUP_RETENTION_DAYS"
  | "D1_BACKUP_WORKFLOW"
>;

interface RuntimeEnv extends BackupEnvLike, BackupHttpEnv {
  D1_REST_API_TOKEN?: string;
  BACKUP_BUCKET: R2BucketLike;
}

type GeneratedBindingsMatchRuntime = AssertNoIncompatibleGeneratedBindings<
  IncompatibleGeneratedBindings<WidenWranglerStringBindings<WranglerBindings>, RuntimeEnv>
>;

export type Env = WithRuntimeNarrowing<WidenWranglerStringBindings<WranglerBindings>, RuntimeEnv>;

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
