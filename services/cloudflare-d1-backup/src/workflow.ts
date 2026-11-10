export interface BackupTriggerParams {
  trigger?: "manual" | "scheduled";
  reason?: string;
}

export interface WorkflowInstanceLike {
  id: string;
  status(): Promise<unknown>;
}

export interface WorkflowBindingLike<T> {
  create(options?: { id?: string; params?: T }): Promise<WorkflowInstanceLike>;
  get(id: string): Promise<WorkflowInstanceLike>;
}

export interface BackupWorkflowEnv {
  D1_BACKUP_WORKFLOW: WorkflowBindingLike<BackupTriggerParams>;
}

export function workflowInstanceId(kind: "manual" | "scheduled", nowMs: number): string {
  const timestamp = new Date(nowMs).toISOString().replace(/[^0-9A-Za-z]/g, "").slice(0, 17);
  return `${kind}-${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
}
