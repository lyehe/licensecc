import { type BackupWorkflowEnv, workflowInstanceId } from "./workflow.js";

export interface ScheduledControllerLike {
  cron: string;
  scheduledTime: number;
}

export type ScheduledBackupEnv = BackupWorkflowEnv;

export function startScheduledBackupWorkflow(controller: ScheduledControllerLike, env: ScheduledBackupEnv): Promise<unknown> {
  const scheduledTime = Number.isFinite(controller.scheduledTime) ? controller.scheduledTime : Date.now();
  return env.D1_BACKUP_WORKFLOW.create({
    id: workflowInstanceId("scheduled", scheduledTime),
    params: { trigger: "scheduled", reason: `cron:${controller.cron}` },
  });
}
