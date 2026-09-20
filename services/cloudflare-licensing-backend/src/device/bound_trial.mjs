// Protected-only trial policy. Legacy trial evaluation remains unchanged.
// Callers supply a verified/registered key, never a self-reported machine ID.
const activationBases = new Set(["from_first_activation", "from_first_use"]);
const safeTime = value => Number.isSafeInteger(value) && value >= 0;
const keyId = value => typeof value === "string" && value.length === 71 && /^sha256:[0-9a-f]{64}$/.test(value);

export function boundTrialState(row, provenKeyId, now, allowUnstarted = true) {
  if (row.is_trial === 0) return { stamp: 0, expiresAt: null };
  if (row.is_trial !== 1 || !safeTime(now) || !keyId(provenKeyId)
      || ![0, 1].includes(row.trial_one_per_device) || ![0, 1].includes(row.trial_require_device_proof)) return null;
  const pending = row.trial_started_at === null;
  if (pending ? (!allowUnstarted || row.trial_device_hash !== null)
    : (!safeTime(row.trial_started_at) || row.trial_started_at > now || !keyId(row.trial_device_hash))) return null;
  if (!pending && row.trial_one_per_device === 1 && row.trial_device_hash !== provenKeyId) return null;
  let expiresAt;
  if (row.trial_expiration_basis === "from_issue") {
    expiresAt = row.valid_until;
    if (!safeTime(expiresAt)) return null;
  } else if (activationBases.has(row.trial_expiration_basis)) {
    if (!Number.isSafeInteger(row.trial_duration_sec) || row.trial_duration_sec < 2) return null;
    expiresAt = (pending ? now : row.trial_started_at) + row.trial_duration_sec;
    if (!safeTime(expiresAt)) return null;
  } else return null;
  return expiresAt > now ? { stamp: pending ? 1 : 0, expiresAt } : null;
}

// Arguments are owner-controlled SQL identifiers/expressions, not request data.
// Keep this predicate aligned with boundTrialState; SQL is final authority.
export function boundTrialSql(e, provenKey, now = "unixepoch()", allowUnstarted = true) {
  const started = `${e}.trial_started_at`, hash = `${e}.trial_device_hash`;
  return `(${e}.is_trial=0 OR (${e}.is_trial=1
    AND length(${provenKey})=71 AND length(CAST(${provenKey} AS BLOB))=71 AND substr(${provenKey},1,7)='sha256:'
    AND substr(${provenKey},8) NOT GLOB '*[^0-9a-f]*'
    AND ${e}.trial_one_per_device IN (0,1) AND ${e}.trial_require_device_proof IN (0,1)
    AND ((${allowUnstarted ? "1" : "0"}=1 AND ${started} IS NULL AND ${hash} IS NULL)
      OR (typeof(${started})='integer' AND ${started} BETWEEN 0 AND ${now}
        AND length(${hash})=71 AND length(CAST(${hash} AS BLOB))=71 AND substr(${hash},1,7)='sha256:'
        AND substr(${hash},8) NOT GLOB '*[^0-9a-f]*'
        AND (${e}.trial_one_per_device=0 OR ${hash}=${provenKey})))
    AND ((${e}.trial_expiration_basis='from_issue' AND typeof(${e}.valid_until)='integer'
        AND ${e}.valid_until BETWEEN 0 AND 9007199254740991 AND ${e}.valid_until>${now})
      OR (${e}.trial_expiration_basis IN ('from_first_activation','from_first_use')
        AND typeof(${e}.trial_duration_sec)='integer' AND ${e}.trial_duration_sec>=2
        AND ${e}.trial_duration_sec<=9007199254740991-coalesce(${started},${now})
        AND coalesce(${started},${now})+${e}.trial_duration_sec>${now}))))`;
}

export function boundTrialDeadlineSql(e, prospectiveStart) {
  return `(CASE WHEN ${e}.trial_expiration_basis='from_issue' THEN ${e}.valid_until
    ELSE coalesce(${e}.trial_started_at,${prospectiveStart})+${e}.trial_duration_sec END)`;
}
