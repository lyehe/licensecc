import { validConsentResponse } from "../../shared/consent";
import { protectedDeviceRequest, type ProtectedDeviceResult } from "./protectedDeviceRequest";
export type ConsentInspection = {app:{name:string;project:string};device:{label:string};status:"pending"|"approved"|"consumed"|"denied";revision:number;expires_at:number;
  entitlements:Array<{id:string;feature:string;valid_until:number|null;device_limit:number;devices_in_use:number;slot_free_at:number|null;device_connected:boolean;activation_trial_seconds?:number}>;has_more:boolean;next_page_cursor:string|null;comparison_code:string};
export type ConsentApproval = {callback_url:string;expires_at:number;revision:number};
export type ConsentResult<T> = ProtectedDeviceResult<T>;
const success={inspect:"authorization_inspected",approve:"authorization_approved",deny:"authorization_denied"};
const errors:Record<string,number>={invalid_request:400,unauthorized:401,cross_site_forbidden:403,access_denied:403,authorization_unavailable:404,
  account_changed:409,revision_conflict:409,idempotency_conflict:409,authorization_expired:410,rate_limited:429,config_error:503,temporarily_unavailable:503};

export async function consentApi<T>(operation:"inspect"|"approve"|"deny",body:unknown,customerId:string,key?:string):Promise<ConsentResult<T>> {
  return protectedDeviceRequest<T>({
    path: `/api/portal/device-authorizations/${operation}`,
    method: "POST",
    body,
    customerId,
    ...(key ? { idempotencyKey: key } : {}),
    successCode: success[operation],
    failureStatuses: errors,
    validate: (data): data is T => validConsentResponse(operation, data),
  });
}
