import type { LabeledPathFragment } from "../assemble.js";
import { ADMIN_AUTH_ERRORS,ADMIN_SECURITY,errorResponse,idParam } from "../components.js";
const text={type:"string"},integer={type:"integer",minimum:0,maximum:9007199254740991};
const binding={type:"string",pattern:"^[A-Za-z0-9_-]{22}$",description:"Canonical unpadded base64url encoding of 16 bytes."};
const object=(properties:Record<string,unknown>)=>({type:"object",additionalProperties:false,required:Object.keys(properties),properties});
const bindingParam={name:"bindingId",in:"path",required:true,schema:binding};
const response=(code:string,data:unknown)=>({description:"Authenticated result; no-store.",content:{"application/json":{schema:object({ok:{const:true},code:{const:code},request_id:text,data})}}});
const page=(items:unknown,events=false)=>object({customer:object({id:text,status:{enum:["active","disabled"]}}),operator:object({subject:text,actor_type:{enum:["access","dev"]},role:{enum:["reader","admin"]}}),server_time:integer,
  ...(events?{binding_id:binding}:{}),items:{type:"array",maxItems:100,items},next_cursor:{type:["string","null"]}});
const reads={...ADMIN_AUTH_ERRORS,"400":errorResponse("Invalid path or bounded keyset query.","invalid_request"),"404":errorResponse("Customer or owned binding unavailable.","not_found","binding_unavailable"),"503":errorResponse("Database unavailable.","temporarily_unavailable")};
export const bindingPaths:LabeledPathFragment={label:"protected-bindings",entries:[
  ["/api/admin/customers/{id}/bindings",{get:{tags:["admin:customers"],operationId:"listCustomerBindings",security:ADMIN_SECURITY,
    summary:"List owned protected connections, including disabled customers' retained records.",
    description:"At most 100 rows ordered by binding ID. Live keyset pages recheck both device and entitlement ownership; refresh to see inserts before a cursor. State is projected using database server_time: active bindings retain capacity after lease expiry; retiring bindings at the hold deadline are released. Last verified contact is not live presence. No private keys or proofs are exposed. The operator object comes from current authentication and supports the retirement precondition.",
    parameters:[idParam,{name:"cursor",in:"query",schema:binding},{name:"binding_id",in:"query",schema:binding,description:"Exact lookup; mutually exclusive with cursor."},{name:"project",in:"query",schema:{...text,minLength:1,maxLength:256}}],responses:{...reads,
      "200":response("customer_bindings",page(object({binding_id:binding,project:text,feature:text,license_fingerprint:text,generation:integer,revision:integer,hold_until:integer,state:{enum:["active","retiring","released"]},label:text,last_proof_at:integer,created_at:integer})))},
  }}],
  ["/api/admin/customers/{id}/bindings/{bindingId}/events",{get:{tags:["admin:customers"],operationId:"listBindingEvents",security:ADMIN_SECURITY,
    summary:"Read a protected connection's audit history.",description:"Current ownership is rechecked. At most 100 events in ascending event-ID order; next_cursor is an exclusive event ID. Operator actors use operator:<type>:<subject>; customer retirement uses customer. This is authenticated history, not a claim of immediate revocation of offline access.",
    parameters:[idParam,bindingParam,{name:"cursor",in:"query",schema:{type:"string",pattern:"^(0|[1-9][0-9]{0,15})(?![\\s\\S])"},description:"Canonical decimal safe-integer event ID from next_cursor; no whitespace."}],responses:{...reads,
      "200":response("binding_events",page(object({id:integer,event_type:{enum:["exchange","renew","retire"]},actor:text,occurred_at:integer}),true))},
  }}],
  ["/api/admin/customers/{id}/bindings/{bindingId}/retire",{post:{tags:["admin:customers"],operationId:"retireCustomerBinding",security:ADMIN_SECURITY,
    summary:"Retire a protected connection as the authenticated administrator.",
    description:"Requires admin role and an active target customer. The named backend capability rechecks ownership, commits retirement/audit atomically and preserves the maximum hold. effective_release_at is the later of that hold and commit time. Identical body/key/operator retries recover for 48 hours; a timeout is an unknown outcome and must retain the same key. No legacy fallback, ownership edit or force-release override. Strict JSON rejects unknown/duplicate fields, malformed UTF-8 and noninteger numeric lexemes; maximum body 16 KiB. All responses are no-store.",
    parameters:[idParam,bindingParam,{name:"idempotency-key",in:"header",required:true,schema:{type:"string",pattern:"^[A-Za-z0-9_-]{43}$"},description:"Canonical base64url encoding of 32 random bytes."},
      {name:"x-expected-operator",in:"header",required:true,schema:text,description:"encodeURIComponent(JSON.stringify([operator.actor_type,operator.subject])) from the displayed binding read. A precondition only; authority comes from authentication."}],
    requestBody:{required:true,content:{"application/json":{schema:object({expected_revision:{...integer,maximum:9007199254740990}})}}},responses:{...ADMIN_AUTH_ERRORS,
      "200":response("binding_retired",object({binding_id:binding,state:{const:"retiring"},effective_release_at:integer,revision:{...integer,minimum:1},generation:{...integer,minimum:2}})),
      "400":errorResponse("Invalid bounded request or retry key.","invalid_request"),
      "403":errorResponse("Role, origin or backend authority denied.","invalid_access_jwt","admin_role_denied","admin_role_required","cross_site_mutation_forbidden","access_denied"),
      "404":errorResponse("Binding unavailable in the active customer context.","binding_unavailable"),
      "409":errorResponse("Operator changed, stale revision, changed intent or expired recovery. Review before a new action.","operator_changed","revision_conflict","idempotency_conflict"),
      "503":errorResponse("Private backend capability unavailable. Preserve pending intent.","temporarily_unavailable")},
  }}],
]};
