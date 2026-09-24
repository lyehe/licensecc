import type { DbDatabaseLike, DbPreparedStatementLike } from "../d1/contract";

/** The activation request fields the write-once trial stamp is keyed by. */
export interface TrialActivationStampRequest {
  project: string;
  feature: string;
  license_fingerprint: string;
  device_key_id: string;
}

/**
 * The write-once start of a legacy activation-basis trial: stamps trial_started_at and
 * trial_device_hash only while the trial is unstarted, and only beside the lease row issued at `now`.
 */
export function buildTrialActivationStamp(
  env: { DB: DbDatabaseLike },
  body: TrialActivationStampRequest,
  lockKey: string,
  now: number,
): DbPreparedStatementLike;

/**
 * SQL expression for when a legacy trial on the entitlements row aliased `e` ends, kept aligned with
 * evaluateTrialActivation: trial_started_at + trial_duration_sec for an activation basis with a
 * positive duration (NULL until the first activation), otherwise valid_until. `e` must be an SQL alias.
 */
export function legacyTrialDeadlineSql(e: string): string;
