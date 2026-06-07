import { type BackupEnvLike, backupConfigFromEnv, timingSafeTokenEqual } from "./core.js";

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

export interface BackupHttpEnv extends BackupEnvLike {
  BACKUP_TRIGGER_TOKEN?: string;
  D1_BACKUP_WORKFLOW: WorkflowBindingLike<BackupTriggerParams>;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match === null ? null : match[1] ?? null;
}

async function requireManualTrigger(request: Request, env: BackupHttpEnv): Promise<Response | null> {
  if (env.BACKUP_TRIGGER_TOKEN === undefined || env.BACKUP_TRIGGER_TOKEN === "") {
    return json({ ok: false, code: "backup_trigger_not_configured" }, 401);
  }
  const token = bearerToken(request);
  if (token === null || !await timingSafeTokenEqual(token, env.BACKUP_TRIGGER_TOKEN)) {
    return json({ ok: false, code: "invalid_backup_trigger_token" }, 403);
  }
  return null;
}

function workflowInstanceId(kind: "manual" | "scheduled", nowMs: number): string {
  const timestamp = new Date(nowMs).toISOString().replace(/[^0-9A-Za-z]/g, "").slice(0, 17);
  return `${kind}-${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
}

async function manualParams(request: Request): Promise<BackupTriggerParams> {
  if (request.headers.get("content-type")?.includes("application/json") !== true) {
    return { trigger: "manual" };
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 1024) {
    throw new Error("request_too_large");
  }
  const value: unknown = await request.json();
  if (typeof value !== "object" || value === null) {
    return { trigger: "manual" };
  }
  const record = value as Record<string, unknown>;
  const reason = typeof record.reason === "string" ? record.reason.slice(0, 256) : undefined;
  return reason === undefined ? { trigger: "manual" } : { trigger: "manual", reason };
}

export async function handleBackupRequest(request: Request, env: BackupHttpEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    try {
      const config = backupConfigFromEnv(env);
      return json({
        ok: true,
        code: "backup_ready",
        database_name: config.databaseName,
        backup_prefix: config.prefix,
        retention_days: config.retentionDays,
      });
    } catch (error) {
      return json({ ok: false, code: "backup_misconfigured", detail: error instanceof Error ? error.message : String(error) }, 500);
    }
  }
  if (request.method === "POST" && url.pathname === "/backup/run") {
    const auth = await requireManualTrigger(request, env);
    if (auth !== null) {
      return auth;
    }
    let params: BackupTriggerParams;
    try {
      params = await manualParams(request);
    } catch (error) {
      return json({ ok: false, code: error instanceof Error ? error.message : "invalid_request" }, 400);
    }
    const instance = await env.D1_BACKUP_WORKFLOW.create({
      id: workflowInstanceId("manual", Date.now()),
      params,
    });
    return json({ ok: true, code: "backup_started", id: instance.id, details: await instance.status() }, 202);
  }
  const statusMatch = /^\/backup\/status\/([A-Za-z0-9_.:-]+)$/.exec(url.pathname);
  if (request.method === "GET" && statusMatch !== null) {
    const auth = await requireManualTrigger(request, env);
    if (auth !== null) {
      return auth;
    }
    const id = statusMatch[1] ?? "";
    try {
      const instance = await env.D1_BACKUP_WORKFLOW.get(id);
      return json({ ok: true, code: "backup_status", id, details: await instance.status() });
    } catch (error) {
      return json({ ok: false, code: "backup_instance_not_found", detail: error instanceof Error ? error.message : String(error) }, 404);
    }
  }
  return json({ ok: false, code: "not_found" }, 404);
}
