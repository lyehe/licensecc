import { decodeBase64url } from "@licensecc/licensing-domain/lease/device_protocol";
import { readUnsignedJson,UnsignedJsonError } from "@licensecc/cloudflare-runtime/http/unsigned_json";
import type { Actor } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type { Env } from "../../env.js";
import { json } from "../../responses.js";

const respond=(rid:string,code:string,status:number,data?:unknown)=>json({ok:status>=200&&status<300,code,request_id:rid,data},status,{"cache-control":"no-store"});
const id=(value:unknown,bytes:number):boolean=>{if(typeof value!=="string")return false;try{return decodeBase64url(value,bytes).length===bytes;}catch{return false;}};
const principal=(actor:Actor)=>({subject:actor.subject,actor_type:actor.actorType,role:actor.role});
const operatorKey=(actor:Actor)=>encodeURIComponent(JSON.stringify([actor.actorType,actor.subject]));
const owned=`FROM device_bound_bindings b JOIN device_bound_devices d ON d.id=b.device_id AND d.project=b.project
  JOIN entitlements e ON e.project=b.project AND e.feature=b.feature AND e.license_fingerprint=b.license_fingerprint
  WHERE d.customer_id=? AND e.customer_id=? AND e.enforcement_mode='device_bound_v1'`;

export async function adminBindings(request:Request,env:Env,actor:Actor,customer:string,rid:string,binding?:string):Promise<Response> {
  try{customer=decodeURIComponent(customer);if(binding!==undefined)binding=decodeURIComponent(binding);}catch{return respond(rid,"invalid_request",400);}
  if(!customer || customer.length>256 || (binding!==undefined && !id(binding,16)))return respond(rid,"invalid_request",400);
  const url=new URL(request.url),cursor=url.searchParams.get("cursor")??"",exact=url.searchParams.get("binding_id"),project=url.searchParams.get("project");
  const allowed=binding===undefined?["cursor","binding_id","project"]:["cursor"];
  if([...url.searchParams.keys()].some(key=>!allowed.includes(key) || url.searchParams.getAll(key).length!==1)
    || (exact!==null && (url.searchParams.has("cursor") || !id(exact,16))) || (project!==null && (!project || project.length>256)))return respond(rid,"invalid_request",400);
  if(url.searchParams.has("cursor") && (binding===undefined?!id(cursor,16):!/^(0|[1-9]\d{0,15})$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || String(Number(cursor))!==cursor))return respond(rid,"invalid_request",400);
  try {
    const db=env.DB.withSession?env.DB.withSession("first-primary"):env.DB;
    let pageSql:string,parameters:unknown[];
    if(binding!==undefined){
      pageSql=`SELECT a.id,a.event_type,a.actor,a.occurred_at FROM device_bound_events a
        JOIN device_bound_bindings b ON b.id=a.binding_id JOIN device_bound_devices d ON d.id=b.device_id AND d.project=b.project
        JOIN entitlements e ON e.project=b.project AND e.feature=b.feature AND e.license_fingerprint=b.license_fingerprint
        WHERE a.binding_id=? AND a.customer_id=? AND d.customer_id=? AND e.customer_id=? AND e.enforcement_mode='device_bound_v1'
        AND a.id>? ORDER BY a.id LIMIT 101`;
      parameters=[binding,customer,customer,customer,Number(cursor||0)];
    }else{
      pageSql=`SELECT b.id AS binding_id,b.project,b.feature,b.license_fingerprint,b.generation,b.revision,b.hold_until,b.state,
        d.label,d.last_proof_at,b.created_at ${owned} AND b.id>?
        ${exact===null?"":"AND b.id=?"} ${project===null?"":"AND b.project=?"} ORDER BY b.id LIMIT 101`;
      parameters=[customer,customer,cursor,...(exact===null?[]:[exact]),...(project===null?[]:[project])];
    }
    // Context, ownership, page and database time share one SQLite statement snapshot.
    const rows=await db.prepare(`WITH context AS MATERIALIZED (SELECT id,status,unixepoch() AS server_time FROM customers WHERE id=?)
      SELECT c.id AS customer_id,c.status AS customer_status,c.server_time,
        ${binding===undefined?'1':`EXISTS(SELECT b.id ${owned} AND b.id=?)`} AS binding_exists,p.*
      FROM context c LEFT JOIN (${pageSql}) p ON 1=1 ORDER BY p.${binding===undefined?'binding_id':'id'}`)
      .bind(customer,...(binding===undefined?[]:[customer,customer,binding]),...parameters).all<Record<string,unknown>>();
    const account=rows.results[0];
    if(!account)return respond(rid,"not_found",404);
    if(!account.binding_exists)return respond(rid,"binding_unavailable",404);
    const page=rows.results.filter(row=>row[binding===undefined?'binding_id':'id']!==null).map(row=>{
      const item={...row};for(const key of ['customer_id','customer_status','server_time','binding_exists'])delete item[key];
      if(binding===undefined && item.state==='retiring' && Number(item.hold_until)<=Number(account.server_time))item.state='released';
      return item;
    });
    const more=page.length>100,items=page.slice(0,100);
    return respond(rid,binding===undefined?"customer_bindings":"binding_events",200,{customer:{id:account.customer_id,status:account.customer_status},operator:principal(actor),server_time:account.server_time,
      ...(binding===undefined?{}:{binding_id:binding}),items,next_cursor:more?String(items.at(-1)![binding===undefined?"binding_id":"id"]):null});
  }catch{return respond(rid,"temporarily_unavailable",503);}
}

type OperatorRpc={retire(actor:ReturnType<typeof principal>,customer:string,input:unknown):Promise<{ok:boolean;status:number;code:string;data?:unknown}>};
const errors:Record<string,number>={invalid_request:400,access_denied:403,binding_unavailable:404,revision_conflict:409,idempotency_conflict:409,temporarily_unavailable:503};
export async function adminRetireBinding(request:Request,env:Env,actor:Actor,customer:string,binding:string,rid:string):Promise<Response> {
  if(actor.role!=="admin" || !["access","dev"].includes(actor.actorType))return respond(rid,"admin_role_required",403);
  try{customer=decodeURIComponent(customer);binding=decodeURIComponent(binding);}catch{return respond(rid,"invalid_request",400);}
  if(!customer || customer.length>256 || !id(binding,16) || request.url.includes('?') || request.url.includes('#'))return respond(rid,"invalid_request",400);
  const expected=request.headers.get("x-expected-operator");
  if(!expected)return respond(rid,"invalid_request",400);
  if(expected!==operatorKey(actor))return respond(rid,"operator_changed",409);
  const key=request.headers.get("idempotency-key");if(!id(key,32))return respond(rid,"invalid_request",400);
  try {
    const input=await readUnsignedJson(request);
    if(Object.keys(input).length!==1 || !Object.hasOwn(input,"expected_revision") || !Number.isSafeInteger(input.expected_revision)
      || Object.is(input.expected_revision,-0) || (input.expected_revision as number)<0 || (input.expected_revision as number)>=Number.MAX_SAFE_INTEGER)return respond(rid,"invalid_request",400);
    if(!env.DEVICE_OPERATOR)return respond(rid,"temporarily_unavailable",503);
    const result=await (env.DEVICE_OPERATOR as unknown as OperatorRpc).retire(principal(actor),customer,{binding_id:binding,expected_revision:input.expected_revision,operation_id:key});
    const data=result?.data as Record<string,unknown>|undefined;
    if(result?.ok===true && result.status===200 && result.code==="binding_retired" && data && typeof data==="object" && !Array.isArray(data)
      && Object.keys(data).sort().join(',')==='binding_id,effective_release_at,generation,revision,state' && data.binding_id===binding
      && data.state==='retiring' && data.revision===(input.expected_revision as number)+1 && Number.isSafeInteger(data.generation) && (data.generation as number)>=2
      && Number.isSafeInteger(data.effective_release_at) && (data.effective_release_at as number)>=0 && !Object.is(data.effective_release_at,-0))return respond(rid,result.code,200,data);
    if(result?.ok===false && typeof result.code==='string' && Object.hasOwn(errors,result.code) && errors[result.code]===result.status)return respond(rid,result.code,result.status);
    return respond(rid,"temporarily_unavailable",503);
  }catch(error){return respond(rid,error instanceof UnsignedJsonError?"invalid_request":"temporarily_unavailable",error instanceof UnsignedJsonError?400:503);}
}
