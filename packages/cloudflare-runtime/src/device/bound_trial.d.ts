/** The entitlements columns the protected-trial rule reads. Each one is validated, never trusted. */
export interface BoundTrialRow {
  is_trial: unknown;
  trial_expiration_basis: unknown;
  trial_duration_sec: unknown;
  trial_one_per_device: unknown;
  trial_started_at: unknown;
  trial_device_hash: unknown;
  valid_until: unknown;
}

/**
 * Trial access to a protected grant for the device holding `provenKeyId` at `now`: null when it is
 * denied; otherwise whether this request starts the trial clock (`stamp`) and when trial access
 * ends (`expiresAt`, null for a grant that is not a trial). boundTrialSql is its SQL twin and the
 * final authority.
 */
export function boundTrialState(
  row: BoundTrialRow,
  provenKeyId: string,
  now: number,
  allowUnstarted?: boolean,
): { stamp: 0 | 1; expiresAt: number | null } | null;

/**
 * SQL predicate twin of boundTrialState over the entitlements row aliased `e`. Every argument is
 * owner-controlled SQL (a table alias, a column, `unixepoch()`, or a bound `?`), never request data.
 */
export function boundTrialSql(e: string, provenKey: string, now?: string, allowUnstarted?: boolean): string;

/**
 * SQL expression for when the trial on the entitlements row aliased `e` ends: valid_until for a
 * from_issue trial; otherwise trial_started_at, or `prospectiveStart` while the trial is unstarted,
 * plus trial_duration_sec. With the SQL literal NULL as `prospectiveStart`, an unstarted trial has no
 * end yet (NULL).
 */
export function boundTrialDeadlineSql(e: string, prospectiveStart: string): string;
