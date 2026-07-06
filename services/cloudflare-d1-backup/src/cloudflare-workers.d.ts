declare module "cloudflare:workers" {
  export type WorkflowCronSchedule = {
    cron: string;
    scheduledTime: number;
  };

  export type WorkflowEvent<T = unknown> = {
    payload: Readonly<T>;
    timestamp: Date;
    instanceId: string;
    workflowName: string;
    schedule?: WorkflowCronSchedule;
  };

  export type WorkflowBackoff = "constant" | "linear" | "exponential";

  export type WorkflowStepConfig = {
    retries?: {
      limit: number;
      delay: string | number;
      backoff?: WorkflowBackoff;
    };
    timeout?: string | number;
  };

  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
  }

  export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    env: Env;
    run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
  }
}
