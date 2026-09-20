import { encodeBase64url, decodeEnrollmentPageCursor } from "@licensecc/licensing-domain/lease/device_protocol";
import { BoundRequestError } from "./bound_request.mjs";
import { boundTrialSql, boundTrialDeadlineSql } from "./bound_trial.mjs";

const encode=value=>encodeBase64url(new TextEncoder().encode(JSON.stringify(value)));
// This unsigned cursor is a position, not authority. Every query rechecks the
// current session customer and attempt; context hashes prevent accidental reuse.
export function consentPageCursor(attemptHash,customerHash,row) {
  return encode(["ep1",attemptHash,customerHash,row.page_feature,row.page_fingerprint]);
}
export function readConsentPageCursor(value,attemptHash,customerHash) {
  if(value===undefined)return ["",""];
  try {
    const tuple=decodeEnrollmentPageCursor(value);
    if(tuple[1]!==attemptHash || tuple[2]!==customerHash)throw new Error();
    return [tuple[3],tuple[4]];
  }catch{throw new BoundRequestError();}
}

// One read owns both the authenticated context and page. An empty result still
// carries context so it cannot masquerade as a missing/disabled customer.
export const CONSENT_PAGE_SQL=`WITH context AS (
  SELECT a.*,c.status AS current_customer_status,unixepoch() AS now
  FROM (SELECT 1) seed LEFT JOIN customers c ON c.id=?
  LEFT JOIN device_bound_authorizations a ON a.handle_hash=?
), page AS (
  SELECT e.feature AS page_feature,e.license_fingerprint AS page_fingerprint,
    CASE WHEN e.is_trial=1 AND e.trial_started_at IS NOT NULL
      THEN min(coalesce(e.valid_until,9007199254740991),${boundTrialDeadlineSql("e","a.now")})
      ELSE e.valid_until END AS page_valid_until,e.max_active_devices AS page_device_limit,
    CASE WHEN e.is_trial=1 AND e.trial_started_at IS NULL
      AND e.trial_expiration_basis IN ('from_first_activation','from_first_use')
      THEN e.trial_duration_sec ELSE NULL END AS page_activation_trial_seconds
  FROM entitlements e JOIN context a ON e.project=a.project
  WHERE a.current_customer_status='active' AND (a.customer_id IS NULL OR a.customer_id=?)
    AND a.status='pending' AND a.expires_at>a.now
    AND e.customer_id=? AND e.status='active' AND e.enforcement_mode='device_bound_v1'
    AND (a.requested_feature IS NULL OR e.feature=a.requested_feature)
    AND e.pool_size=0 AND ${boundTrialSql("e","a.key_id","a.now")}
    AND (e.valid_from IS NULL OR e.valid_from<=a.now) AND (e.valid_until IS NULL OR e.valid_until>a.now)
    AND (e.feature,e.license_fingerprint)>(?,?)
  ORDER BY e.feature,e.license_fingerprint LIMIT 101
)
SELECT a.*,p.* FROM context a LEFT JOIN page p ON 1=1 ORDER BY p.page_feature,p.page_fingerprint`;
