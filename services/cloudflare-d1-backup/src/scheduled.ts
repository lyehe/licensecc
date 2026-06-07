import type { BackupTriggerParams, WorkflowBindingLike } from "./http.js";

export interface ScheduledControllerLike {
  cron: string;
  scheduledTime: number;
}

export interface ScheduledBackupEnv {
  D1_BACKUP_WORKFLOW: WorkflowBindingLike<BackupTriggerParams>;
}

function workflowInstanceId(kind: "scheduled", nowMs: number): string {
  const timestamp = new Date(nowMs).toISOString().replace(/[^0-9A-Za-z]/g, "").slice(0, 17);
  return `${kind}-${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
}

export function startScheduledBackupWorkflow(controller: ScheduledControllerLike, env: ScheduledBackupEnv): Promise<unknown> {
  const scheduledTime = Number.isFinite(controller.scheduledTime) ? controller.scheduledTime : Date.now();
  return env.D1_BACKUP_WORKFLOW.create({
    id: workflowInstanceId("scheduled", scheduledTime),
    params: { trigger: "scheduled", reason: `cron:${controller.cron}` },
  });
}
