import type { EntitlementRecord } from "../../../shared/api";
import { exactExpiry, expiryDescription } from "./expiry";

type Validity = Pick<EntitlementRecord,"valid_until"|"is_trial"|"trial_expiration_basis"|"trial_duration_sec"|"trial_started_at">;

function trialDeadline(item: Validity): number | null {
  if(item.is_trial!==1 || !["from_first_activation","from_first_use"].includes(item.trial_expiration_basis??"")
    || item.trial_started_at===null || !Number.isSafeInteger(item.trial_started_at) || item.trial_started_at<0
    || !Number.isSafeInteger(item.trial_duration_sec) || item.trial_duration_sec<2)return null;
  const end=item.trial_started_at+item.trial_duration_sec;
  return Number.isSafeInteger(end)?end:null;
}

/** Presentation only: stored grant dates and frozen trial clocks both constrain access. */
export function entitlementDeadline(item: Validity): number | null {
  const trial=trialDeadline(item);
  return trial===null?item.valid_until:item.valid_until===null?trial:Math.min(item.valid_until,trial);
}

function duration(seconds: number): string {
  for(const [size,unit] of [[86400,"day"],[3600,"hour"],[60,"minute"],[1,"second"]] as const){
    if(seconds%size===0){const count=seconds/size;return `${count} ${unit}${count===1?"":"s"}`;}
  }
  return `${seconds} seconds`;
}

export function entitlementExpiryDescription(item: Validity): string {
  if(item.is_trial!==1)return expiryDescription(item.valid_until);
  const grant=item.valid_until===null?"":` Grant: ${expiryDescription(item.valid_until)}.`;
  if(item.trial_expiration_basis==="from_issue")return item.valid_until===null?"Trial expiry unavailable.":`Trial from issue. ${expiryDescription(item.valid_until)}.`;
  const basis=item.trial_expiration_basis==="from_first_activation"?"first activation":item.trial_expiration_basis==="from_first_use"?"first use":null;
  if(!basis || !Number.isSafeInteger(item.trial_duration_sec) || item.trial_duration_sec<2)return `Trial expiry unavailable.${grant}`;
  const clock=`Trial: ${duration(item.trial_duration_sec)} from ${basis}.`;
  if(item.trial_started_at===null)return `${clock}${grant}`;
  const trial=trialDeadline(item),end=entitlementDeadline(item);
  if(trial===null || end===null)return `Trial expiry unavailable.${grant}`;
  const source=item.valid_until!==null && item.valid_until<=trial?"limited by grant expiry":`derived from ${basis}`;
  return `Trial expires ${exactExpiry(end)} (${source}). ${clock}${grant}`;
}
