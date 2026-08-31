import {
  type BackupSnapshotInventory,
  streamWithSnapshotInventory,
} from "./snapshot-inventory.js";

export {
  type BackupSnapshotInventory,
  SNAPSHOT_COUNTED_TABLES,
  snapshotInventoryFromSql,
} from "./snapshot-inventory.js";

export interface BackupEnvLike {
  ACCOUNT_ID?: string;
  DATABASE_ID?: string;
  DATABASE_NAME?: string;
  BACKUP_PREFIX?: string;
  BACKUP_RETENTION_DAYS?: string;
}

export interface BackupConfig {
  accountId: string;
  databaseId: string;
  databaseName: string;
  prefix: string;
  retentionDays: number;
}

export interface D1ExportStarted {
  bookmark: string;
  snapshotRequestedAt: string;
}

export interface D1ExportReady {
  filename: string;
  signedUrl: string;
}

export interface BackupObjectManifest {
  database_id: string;
  database_name: string;
  source: "cloudflare-d1-export";
  bookmark: string;
  export_filename: string;
  object_key: string;
  snapshot_requested_at: string;
  /** R2's authoritative upload timestamp for the SQL object, not the RPO basis. */
  created_at: string;
  content_integrity: BackupContentIntegrity;
  snapshot_inventory: BackupSnapshotInventory;
}

export interface BackupContentIntegrity {
  algorithm: "sha256";
  digest_hex: string;
  size_bytes: number;
  r2_etag: string;
  r2_version: string;
  r2_size_bytes: number;
  r2_sha256_hex?: string;
}

export interface BackupResult {
  database_id: string;
  database_name: string;
  bookmark: string;
  export_filename: string;
  object_key: string;
  manifest_key: string;
  snapshot_requested_at: string;
  created_at: string;
  content_integrity: BackupContentIntegrity;
  snapshot_inventory: BackupSnapshotInventory;
  pruned_objects: number;
}

export interface R2PutOptionsLike {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2ObjectLike {
  key: string;
  uploaded: Date | string;
}

export interface R2PutResultLike {
  key: string;
  version: string;
  size: number;
  etag: string;
  uploaded: Date | string;
  checksums?: { sha256?: ArrayBuffer | ArrayBufferView };
}

export interface R2ListResultLike {
  objects: R2ObjectLike[];
  truncated: boolean;
  cursor?: string;
}

export interface R2BucketLike {
  put(key: string, value: ReadableStream<Uint8Array> | string, options?: R2PutOptionsLike): Promise<R2PutResultLike | null>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2ListResultLike>;
  delete(keys: string | string[]): Promise<unknown>;
}

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_DATABASE_NAME = "licensecc-online-verifier";
const DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 3650;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name}_required`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function parseRetentionDays(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_RETENTION_DAYS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_RETENTION_DAYS) {
    throw new Error(`BACKUP_RETENTION_DAYS must be an integer in [1, ${MAX_RETENTION_DAYS}]`);
  }
  return parsed;
}

export function sanitizeBackupPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (trimmed === "" || trimmed.includes("..") || trimmed.includes("//") || !/^[A-Za-z0-9._/-]+$/.test(trimmed)) {
    throw new Error("BACKUP_PREFIX must contain only letters, numbers, '.', '_', '-', and '/' without traversal");
  }
  return trimmed;
}

function sanitizeObjectSegment(value: string): string {
  const segment = value.split(/[\\/]/).filter((part) => part !== "").at(-1) ?? "database.sql";
  const safe = segment.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe === "" || safe === "." || safe === ".." ? "database.sql" : safe;
}

export function backupConfigFromEnv(env: BackupEnvLike): BackupConfig {
  const databaseName = optionalString(env.DATABASE_NAME) ?? DEFAULT_DATABASE_NAME;
  return {
    accountId: requiredString(env.ACCOUNT_ID, "ACCOUNT_ID"),
    databaseId: requiredString(env.DATABASE_ID, "DATABASE_ID"),
    databaseName,
    prefix: sanitizeBackupPrefix(optionalString(env.BACKUP_PREFIX) ?? `d1/${databaseName}`),
    retentionDays: parseRetentionDays(env.BACKUP_RETENTION_DAYS),
  };
}

export function requireD1RestApiToken(env: { D1_REST_API_TOKEN?: string }): string {
  return requiredString(env.D1_REST_API_TOKEN, "D1_REST_API_TOKEN");
}

export function d1ExportUrl(config: BackupConfig): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/d1/database/${encodeURIComponent(config.databaseId)}/export`;
}

function authHeaders(token: string): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  return headers;
}

function cloudflareErrors(value: Record<string, unknown>): string {
  const errors = value.errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return "unknown_error";
  }
  return errors
    .map((error) => {
      const record = asRecord(error);
      return typeof record?.message === "string" ? record.message : "unknown_error";
    })
    .join("; ");
}

async function responseJson(response: Response, label: string): Promise<unknown> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new Error(`${label}_invalid_json:${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const record = asRecord(value);
    throw new Error(`${label}_http_${response.status}:${record === null ? "unknown_error" : cloudflareErrors(record)}`);
  }
  return value;
}

function envelopeResult(value: unknown, label: string): Record<string, unknown> {
  const envelope = asRecord(value);
  if (envelope === null) {
    throw new Error(`${label}_invalid_envelope`);
  }
  if (envelope.success === false) {
    throw new Error(`${label}_failed:${cloudflareErrors(envelope)}`);
  }
  const result = asRecord(envelope.result);
  if (result === null) {
    throw new Error(`${label}_missing_result`);
  }
  return result;
}

export function parseStartExportResponse(value: unknown): Pick<D1ExportStarted, "bookmark"> {
  const result = envelopeResult(value, "d1_export_start");
  const bookmark = result.at_bookmark;
  if (typeof bookmark !== "string" || bookmark === "") {
    throw new Error("d1_export_start_missing_bookmark");
  }
  return { bookmark };
}

export function parseReadyExportResponse(value: unknown): D1ExportReady {
  const result = envelopeResult(value, "d1_export_poll");
  const signedUrl = result.signed_url;
  const filename = result.filename;
  if (typeof signedUrl !== "string" || signedUrl === "") {
    throw new Error("d1_export_not_ready");
  }
  return {
    signedUrl,
    filename: typeof filename === "string" && filename !== "" ? filename : "database.sql",
  };
}

export async function startD1Export(
  fetcher: Fetcher,
  config: BackupConfig,
  token: string,
  nowMs = Date.now(),
): Promise<D1ExportStarted> {
  if (!Number.isFinite(nowMs)) {
    throw new Error("d1_export_start_clock_invalid");
  }
  // Capture immediately before requesting the snapshot. The Workflow step
  // persists this timestamp together with the bookmark returned by D1.
  const snapshotRequestedAt = new Date(nowMs).toISOString();
  const response = await fetcher(d1ExportUrl(config), {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ output_format: "polling" }),
  });
  return {
    ...parseStartExportResponse(await responseJson(response, "d1_export_start")),
    snapshotRequestedAt,
  };
}

export async function pollD1Export(fetcher: Fetcher, config: BackupConfig, token: string, bookmark: string): Promise<D1ExportReady> {
  const response = await fetcher(d1ExportUrl(config), {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ current_bookmark: bookmark }),
  });
  return parseReadyExportResponse(await responseJson(response, "d1_export_poll"));
}

function backupTimestamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[:.]/g, "-");
}

function canonicalSnapshotRequestedAt(value: string): string {
  const snapshotRequestedAtMs = Date.parse(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(snapshotRequestedAtMs) ||
    new Date(snapshotRequestedAtMs).toISOString() !== value
  ) {
    throw new Error("d1_export_snapshot_requested_at_invalid");
  }
  return value;
}

function r2MetadataString(value: unknown, field: string): string {
  const hasControlCharacter = typeof value === "string" && [...value]
    .some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
  if (typeof value !== "string" || value.length < 1 || value.length > 2048 || hasControlCharacter) {
    throw new Error(`r2_put_invalid_${field}`);
  }
  return value;
}

function r2UploadedAt(value: R2PutResultLike | null): string {
  if (value === null || typeof value !== "object") {
    throw new Error("r2_put_missing_metadata");
  }
  const uploadedMs = value.uploaded instanceof Date ? value.uploaded.getTime() : Date.parse(value.uploaded);
  if (!Number.isFinite(uploadedMs)) {
    throw new Error("r2_put_invalid_uploaded_at");
  }
  return new Date(uploadedMs).toISOString();
}

function checksumHex(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  let bytes: Uint8Array;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new Error("r2_put_invalid_sha256");
  }
  if (bytes.byteLength !== 32) {
    throw new Error("r2_put_invalid_sha256");
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function contentIntegrityFromPut(
  value: R2PutResultLike | null,
  objectKey: string,
  streamed: { digestHex: string; sizeBytes: number },
): BackupContentIntegrity {
  if (value === null || typeof value !== "object") {
    throw new Error("r2_put_missing_metadata");
  }
  if (value.key !== objectKey) {
    throw new Error("r2_put_key_mismatch");
  }
  if (!Number.isSafeInteger(value.size) || value.size < 0) {
    throw new Error("r2_put_invalid_size");
  }
  if (streamed.sizeBytes < 1) {
    throw new Error("d1_export_empty");
  }
  if (value.size !== streamed.sizeBytes) {
    throw new Error("r2_put_size_mismatch");
  }
  const r2Sha256Hex = checksumHex(value.checksums?.sha256);
  if (r2Sha256Hex !== undefined && r2Sha256Hex !== streamed.digestHex) {
    throw new Error("r2_put_sha256_mismatch");
  }
  const integrity: BackupContentIntegrity = {
    algorithm: "sha256",
    digest_hex: streamed.digestHex,
    size_bytes: streamed.sizeBytes,
    r2_etag: r2MetadataString(value.etag, "etag"),
    r2_version: r2MetadataString(value.version, "version"),
    r2_size_bytes: value.size,
  };
  if (r2Sha256Hex !== undefined) {
    integrity.r2_sha256_hex = r2Sha256Hex;
  }
  return integrity;
}

export function backupObjectKey(config: BackupConfig, ready: D1ExportReady, started: D1ExportStarted): string {
  const snapshotRequestedAt = canonicalSnapshotRequestedAt(started.snapshotRequestedAt);
  return `${config.prefix}/${backupTimestamp(Date.parse(snapshotRequestedAt))}/${sanitizeObjectSegment(started.bookmark)}/${sanitizeObjectSegment(ready.filename)}`;
}

export async function saveD1ExportToR2(
  bucket: R2BucketLike,
  fetcher: Fetcher,
  config: BackupConfig,
  started: D1ExportStarted,
  ready: D1ExportReady,
): Promise<Omit<BackupResult, "pruned_objects">> {
  const snapshotRequestedAt = canonicalSnapshotRequestedAt(started.snapshotRequestedAt);
  const dumpResponse = await fetcher(ready.signedUrl);
  if (!dumpResponse.ok || dumpResponse.body === null) {
    throw new Error(`d1_export_download_failed:${dumpResponse.status}`);
  }
  const objectKey = backupObjectKey(config, ready, started);
  const streamingDigest = streamWithSnapshotInventory(dumpResponse.body);
  const putResult = await bucket.put(objectKey, streamingDigest.readable, {
    httpMetadata: { contentType: "application/sql" },
    customMetadata: {
      database_id: config.databaseId,
      database_name: config.databaseName,
      bookmark: started.bookmark,
    },
  });
  const streamed = streamingDigest.result();
  const contentIntegrity = contentIntegrityFromPut(putResult, objectKey, streamed);
  if (Object.keys(streamed.snapshotInventory.table_counts).length < 1) {
    throw new Error("snapshot_inventory_no_counted_tables");
  }
  const objectUploadedAt = r2UploadedAt(putResult);
  if (Date.parse(objectUploadedAt) + MAX_CLOCK_SKEW_MS < Date.parse(snapshotRequestedAt)) {
    throw new Error("r2_put_uploaded_at_before_snapshot");
  }

  const manifest: BackupObjectManifest = {
    database_id: config.databaseId,
    database_name: config.databaseName,
    source: "cloudflare-d1-export",
    bookmark: started.bookmark,
    export_filename: ready.filename,
    object_key: objectKey,
    snapshot_requested_at: snapshotRequestedAt,
    created_at: objectUploadedAt,
    content_integrity: contentIntegrity,
    snapshot_inventory: streamed.snapshotInventory,
  };
  const manifestKey = `${objectKey}.metadata.json`;
  await bucket.put(manifestKey, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      database_id: config.databaseId,
      database_name: config.databaseName,
      bookmark: started.bookmark,
    },
  });

  return {
    database_id: config.databaseId,
    database_name: config.databaseName,
    bookmark: started.bookmark,
    export_filename: ready.filename,
    object_key: objectKey,
    manifest_key: manifestKey,
    snapshot_requested_at: snapshotRequestedAt,
    created_at: objectUploadedAt,
    content_integrity: contentIntegrity,
    snapshot_inventory: streamed.snapshotInventory,
  };
}

function uploadedTime(object: R2ObjectLike): number | null {
  if (object.uploaded instanceof Date) {
    return object.uploaded.getTime();
  }
  const parsed = Date.parse(object.uploaded);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function pruneExpiredBackups(bucket: R2BucketLike, config: BackupConfig, nowMs: number): Promise<number> {
  const cutoff = nowMs - config.retentionDays * 24 * 60 * 60 * 1000;
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const listOptions: { prefix: string; cursor?: string; limit: number } = { prefix: `${config.prefix}/`, limit: 1000 };
    if (cursor !== undefined) {
      listOptions.cursor = cursor;
    }
    const page = await bucket.list(listOptions);
    const expired = page.objects
      .filter((object) => {
        const time = uploadedTime(object);
        return time !== null && time < cutoff;
      })
      .map((object) => object.key);
    if (expired.length > 0) {
      await bucket.delete(expired);
      deleted += expired.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return deleted;
}

export async function timingSafeTokenEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const leftDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(left)));
  const rightDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(right)));
  let diff = left.length === right.length ? 0 : 1;
  for (let index = 0; index < leftDigest.length; ++index) {
    diff |= (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0);
  }
  return diff === 0;
}
