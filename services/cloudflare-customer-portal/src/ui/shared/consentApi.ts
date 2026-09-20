import { validConsentResponse } from "../../shared/consent";
export type ConsentInspection = {app:{name:string;project:string};device:{label:string};status:"pending"|"approved"|"consumed"|"denied";revision:number;expires_at:number;
  entitlements:Array<{id:string;feature:string;valid_until:number|null;device_limit:number;activation_trial_seconds?:number}>;has_more:boolean;next_page_cursor:string|null;comparison_code:string};
export type ConsentApproval = {callback_url:string;expires_at:number;revision:number};
export type ConsentResult<T> = {ok:true;data:T}|{ok:false;code:string;retryAfter?:number};
const success={inspect:"authorization_inspected",approve:"authorization_approved",deny:"authorization_denied"};
const errors:Record<string,number>={invalid_request:400,unauthorized:401,cross_site_forbidden:403,access_denied:403,authorization_unavailable:404,
  account_changed:409,revision_conflict:409,idempotency_conflict:409,authorization_expired:410,rate_limited:429,config_error:503,temporarily_unavailable:503};

export async function consentApi<T>(operation:"inspect"|"approve"|"deny",body:unknown,customerId:string,key?:string):Promise<ConsentResult<T>> {
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
  try {
    const response=await fetch(`/api/portal/device-authorizations/${operation}`,{method:"POST",credentials:"same-origin",cache:"no-store",redirect:"error",signal:controller.signal,
      headers:{"content-type":"application/json","x-expected-customer-id":encodeURIComponent(customerId),...(key?{"idempotency-key":key}:{})},body:JSON.stringify(body)});
    const result=await response.json();
    if (response.status===200 && result?.ok===true && result.code===success[operation] && validConsentResponse(operation,result.data)) return {ok:true,data:result.data as T};
    if (result?.ok===false && typeof result.code==="string" && Object.hasOwn(errors,result.code) && errors[result.code]===response.status) return {ok:false,code:result.code,...(response.status===429?{retryAfter:Math.min(300,Math.max(60,Number(response.headers.get("retry-after"))||60))}:{})};
  } catch { /* Unknown outcomes preserve the saved mutation key. */ }
  finally {clearTimeout(timeout);}
  return {ok:false,code:"temporarily_unavailable"};
}
