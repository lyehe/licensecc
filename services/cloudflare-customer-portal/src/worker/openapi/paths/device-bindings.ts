import type { LabeledPathFragment } from "../assemble.js";
import { errorResponse } from "../components.js";

const text={type:"string"};
const integer={type:"integer",minimum:0,maximum:9007199254740991};
const binding={type:"string",pattern:"^[A-Za-z0-9_-]{22}$",description:"Canonical unpadded base64url encoding of 16 bytes."};
const object=(properties:Record<string,unknown>)=>({type:"object",additionalProperties:false,required:Object.keys(properties),properties});
export const deviceBindingPaths:LabeledPathFragment={label:"device-bindings",entries:[
  ["/api/portal/device-bindings",{get:{
    tags:["portal"],operationId:"portalDeviceBindingsList",summary:"List the signed-in customer's protected node connections.",
    description:"Returns at most 100 bindings in ascending binding ID order. Opaque keyset pagination rechecks current ownership on every page; it is not a snapshot. Restart pagination to see inserts before the cursor. Retiring bindings at or beyond their hold deadline are logically released without waiting for cleanup. Active bindings remain occupied after lease expiry. Last proof time is authenticated contact, not live presence. All responses are no-store.",
    security:[{sessionCookie:[]}],parameters:[
      {name:"x-expected-customer-id",in:"header",required:true,schema:text,description:"encodeURIComponent of the displayed account ID; compared with the session."},
      {name:"cursor",in:"query",required:false,schema:binding,description:"next_cursor from the previous page; omit for the first page."},
      {name:"binding_id",in:"query",required:false,schema:binding,description:"Inspect exactly this owned binding, returning zero or one item. Mutually exclusive with cursor."},
    ],responses:{
      "200":{description:"Owned protected bindings.",content:{"application/json":{schema:object({ok:{const:true},code:{const:"device_bindings"},request_id:text,
        data:object({customer_id:text,items:{type:"array",maxItems:100,items:object({binding_id:binding,project:text,feature:text,revision:integer,hold_until:integer,state:{enum:["active","retiring","released"]},label:text,last_proof_at:integer,created_at:integer,server_time:integer})},has_more:{type:"boolean"},next_cursor:{anyOf:[binding,{type:"null"}]}})})}}},
      "400":errorResponse("Invalid cursor, query or account precondition.",["invalid_request"]),
      "401":errorResponse("Sign in before continuing.",["unauthorized"]),
      "409":errorResponse("The displayed account no longer matches the session.",["account_changed"]),
      "503":errorResponse("Session configuration or database unavailable.",["config_error","temporarily_unavailable"]),
    },
  }}],
  ["/api/portal/device-bindings/retire",{post:{
    tags:["portal"],operationId:"portalDeviceBindingRetire",summary:"Retire an owned protected device binding.",
    description:"Session-derived customer identity only. Stops new renewal immediately; existing signed access and the capacity hold are preserved. effective_release_at is the later of the hold deadline and retirement commit. Retry the identical body and idempotency key after an unknown outcome: exact recovery lasts 48 hours. Released bindings cannot be re-enabled. All responses are no-store. Bodies reject unknown/duplicate keys, invalid UTF-8 and non-integer numeric lexemes, with a 16 KiB limit.",
    security:[{sessionCookie:[]}],
    parameters:[
      {name:"Origin",in:"header",required:true,schema:text,description:"Must equal the configured HTTPS portal origin."},
      {name:"x-expected-customer-id",in:"header",required:true,schema:text,description:"encodeURIComponent of the displayed account ID; compared with the session, never used as authority."},
      {name:"idempotency-key",in:"header",required:true,schema:{type:"string",pattern:"^[A-Za-z0-9_-]{43}$"},description:"Canonical unpadded base64url encoding of 32 random bytes; retain for exact retries."},
    ],
    requestBody:{required:true,content:{"application/json":{schema:object({binding_id:binding,expected_revision:{...integer,maximum:9007199254740990}})}}},
    responses:{
      "200":{description:"Committed retirement or exact recovered result.",content:{"application/json":{schema:object({ok:{const:true},code:{const:"binding_retired"},request_id:text,
        data:object({binding_id:binding,state:{const:"retiring"},effective_release_at:integer,revision:{...integer,minimum:1},generation:{...integer,minimum:2}})})}}},
      "400":errorResponse("Invalid request or idempotency key.",["invalid_request"]),
      "401":errorResponse("Sign in before continuing.",["unauthorized"]),
      "403":errorResponse("Origin or current authority denied.",["cross_site_forbidden","access_denied"]),
      "404":errorResponse("Owned binding unavailable.",["binding_unavailable"]),
      "409":errorResponse("Account changed, stale revision, changed intent, or expired recovery. Refresh before creating a new intent.",["account_changed","revision_conflict","idempotency_conflict"]),
      "429":errorResponse("Shared protected-device global/customer budget exceeded; Retry-After is 60 seconds.",["rate_limited"]),
      "503":errorResponse("Session configuration or backend unavailable; preserve pending intent.",["config_error","temporarily_unavailable"]),
    },
  }}],
]};
