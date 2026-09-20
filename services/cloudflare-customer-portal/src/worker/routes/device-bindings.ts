import { decodeBase64url } from "@licensecc/licensing-domain/lease/device_protocol";
import { envelope } from "../support.js";
import type { Env, SessionRow } from "../env.js";

export async function listBindings(request:Request,env:Env,session:SessionRow,reqId:string):Promise<Response> {
  const respond=(code:string,status:number,data?:unknown)=>envelope(reqId,code,data,status,{"cache-control":"no-store"});
  const expected=request.headers.get("x-expected-customer-id");
  if(!expected)return respond("invalid_request",400);
  if(expected!==encodeURIComponent(session.customer_id))return respond("account_changed",409);
  const url=new URL(request.url),cursor=url.searchParams.get("cursor")??"",binding=url.searchParams.get("binding_id");
  if([...url.searchParams.keys()].some(key=>!["cursor","binding_id"].includes(key)) || [...url.searchParams.keys()].length>1)return respond("invalid_request",400);
  try {if(url.searchParams.has("cursor") && decodeBase64url(cursor,16).length!==16)return respond("invalid_request",400);}
  catch{return respond("invalid_request",400);}
  try {if(binding!==null && decodeBase64url(binding,16).length!==16)return respond("invalid_request",400);}
  catch{return respond("invalid_request",400);}
  try {
    const db=env.DB.withSession?env.DB.withSession("first-primary"):env.DB;
    const rows=await db.prepare(`SELECT b.id AS binding_id,b.project,b.feature,b.revision,b.hold_until,
      CASE WHEN b.state='retiring' AND b.hold_until<=unixepoch() THEN 'released' ELSE b.state END AS state,
      d.label,d.last_proof_at,b.created_at,unixepoch() AS server_time
      FROM device_bound_bindings b JOIN device_bound_devices d ON d.id=b.device_id AND d.project=b.project
      JOIN entitlements e ON e.project=b.project AND e.feature=b.feature AND e.license_fingerprint=b.license_fingerprint
      JOIN customers c ON c.id=d.customer_id AND c.id=e.customer_id
      WHERE c.id=? AND c.status='active' AND e.enforcement_mode='device_bound_v1' AND b.id>?
      ${binding===null?"":"AND b.id=?"} ORDER BY b.id LIMIT 101`).bind(session.customer_id,cursor,...(binding===null?[]:[binding])).all<Record<string,unknown>>();
    const more=rows.results.length>100,items=rows.results.slice(0,100);
    return respond("device_bindings",200,{customer_id:session.customer_id,items,has_more:more,next_cursor:more?items.at(-1)!.binding_id:null});
  } catch{return respond("temporarily_unavailable",503);}
}

export const BINDING_DISPATCH={"GET /api/portal/device-bindings":listBindings};
