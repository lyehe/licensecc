import type { LabeledPathFragment } from "../assemble.js";
import { errorResponse } from "../components.js";

const text = { type:"string" };
const integer = { type:"integer",minimum:0,maximum:9007199254740991 };
const object = (properties: Record<string,unknown>) => ({type:"object",additionalProperties:false,required:Object.keys(properties),properties});
const nullableTime = {anyOf:[integer,{type:"null"}]};
const data = {
  inspect: object({app:object({name:text,project:text}),device:object({label:text}),status:{enum:["pending","approved","consumed","denied"]},revision:integer,expires_at:integer,
    entitlements:{type:"array",maxItems:100,items:{...object({id:text,feature:text,valid_until:nullableTime,device_limit:integer}),
      properties:{id:text,feature:text,valid_until:{...nullableTime,description:"Effective expiry for a started trial; optional absolute cap for an unstarted trial."},device_limit:integer,
        activation_trial_seconds:{...integer,minimum:2,description:"Present only for an unstarted activation-based trial. Starts on successful native exchange, not browser approval; valid_until may cap its duration."}}}},has_more:{type:"boolean"},
    next_page_cursor:{anyOf:[{type:"string",pattern:"^[A-Za-z0-9_-]{1,512}$"},{type:"null"}]},comparison_code:{type:"string",pattern:"^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$"}}),
  approve: object({callback_url:{type:"string",format:"uri"},expires_at:integer,revision:integer}),
  deny: object({status:{const:"authorization_denied"},revision:integer}),
};
export const deviceConsentPaths: LabeledPathFragment = {
  label:"device-consent",
  entries: (["inspect","approve","deny"] as const).map(operation=>[
    `/api/portal/device-authorizations/${operation}`, {post:{
      tags:["portal"],operationId:`portalDeviceAuthorization${operation.charAt(0).toUpperCase()}${operation.slice(1)}`,
      summary:`${operation.charAt(0).toUpperCase()}${operation.slice(1)} a device authorization for the signed-in customer.`,
      description:"Requires the configured portal Origin and a current session. Bodies reject duplicate/unknown keys, invalid UTF-8 and non-integer numeric lexemes, with a 16 KiB limit. Identity comes only from the session. Mutations use attempt-scoped idempotency; approval recovery ends at code expiry and denial recovery at attempt expiry. A timeout is an unknown outcome; retry the identical request and key. All responses are no-store.",
      security:[{sessionCookie:[]}],
      parameters:[{name:"Origin",in:"header",required:true,schema:text},{name:"x-expected-customer-id",in:"header",required:true,schema:text,description:"encodeURIComponent of the customer ID displayed by the browser. Compared to the current session to reject account changes; never supplies authority."},...(operation==="inspect"?[]:[{name:"idempotency-key",in:"header",required:true,schema:{type:"string",pattern:"^[A-Za-z0-9_-]{16,128}$"}}])],
      requestBody:{required:true,content:{"application/json":{schema:{...object({attempt_handle:{type:"string",pattern:"^[A-Za-z0-9_-]{43}$"},
        ...(operation==="approve"?{entitlement_id:text}:{}),...(operation==="inspect"?{page_cursor:{type:"string",pattern:"^[A-Za-z0-9_-]{1,512}$",description:"Optional opaque live keyset position. Omit for the first page; each page rechecks current eligibility. Inserts before the position appear after restarting pagination."}}:{expected_attempt_revision:{...integer,maximum:9007199254740990}})}),
        ...(operation==="inspect"?{required:["attempt_handle"]}:{})}}}},
      responses:{
        "200":{description:"Authenticated consent result.",content:{"application/json":{schema:object({ok:{const:true},code:{const:operation==="inspect"?"authorization_inspected":operation==="approve"?"authorization_approved":"authorization_denied"},request_id:text,data:data[operation]})}}},
        "400":errorResponse("Invalid bounded request or idempotency key.",["invalid_request"]),
        "401":errorResponse("Sign in before continuing.",["unauthorized"]),
        "403":errorResponse("Cross-origin request or current authority denied.",["cross_site_forbidden","access_denied"]),
        "404":errorResponse("Attempt unavailable.",["authorization_unavailable"]),
        "409":errorResponse("Account changed: restart enrollment. Otherwise refresh state or retry the exact original intent.",["account_changed","revision_conflict","idempotency_conflict"]),
        "410":errorResponse("Restart enrollment.",["authorization_expired"]),
        "429":errorResponse("Global or customer budget exceeded; Retry-After is 60 seconds.",["rate_limited"]),
        "503":errorResponse("Session configuration or private service unavailable; preserve pending intent.",["config_error","temporarily_unavailable"]),
      },
    }},
  ]),
};
