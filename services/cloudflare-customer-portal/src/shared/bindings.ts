import { decodeBase64url } from "@licensecc/licensing-domain/lease/device_protocol";
export type BindingRow={binding_id:string;project:string;feature:string;revision:number;hold_until:number;state:"active"|"retiring"|"released";label:string;last_proof_at:number;created_at:number;server_time:number};
export type BindingPage={customer_id:string;items:BindingRow[];has_more:boolean;next_cursor:string|null};
export type Retirement={binding_id:string;state:"retiring";effective_release_at:number;revision:number;generation:number};
export function canonicalId(value:unknown,bytes:number):value is string {
  try{return typeof value==="string" && decodeBase64url(value,bytes).length===bytes;}catch{return false;}
}
const uint=(v:unknown):v is number=>Number.isSafeInteger(v) && (v as number)>=0 && !Object.is(v,-0);
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v && typeof v==="object" && !Array.isArray(v) && Object.keys(v).length===keys.length && keys.every(key=>Object.hasOwn(v,key));
export function validRetirement(data:unknown,body:Record<string,unknown>):data is Retirement {
  return exact(data,["binding_id","state","effective_release_at","revision","generation"])
    && data.binding_id===body.binding_id && data.state==="retiring" && data.revision===(body.expected_revision as number)+1
    && uint(data.generation) && data.generation>=2 && uint(data.effective_release_at);
}
export function validBindingPage(data:unknown,customer:string,cursor:string):data is BindingPage {
  if(!exact(data,["customer_id","items","has_more","next_cursor"]) || data.customer_id!==customer || !Array.isArray(data.items)
      || data.items.length>100 || typeof data.has_more!=="boolean" || data.has_more!==(data.next_cursor!==null))return false;
  let previous=cursor;
  for(const row of data.items) {
    if(!exact(row,["binding_id","project","feature","revision","hold_until","state","label","last_proof_at","created_at","server_time"])
      || !canonicalId(row.binding_id,16) || row.binding_id<=previous
      || !["project","feature","label"].every(key=>typeof row[key]==="string")
      || !["revision","hold_until","last_proof_at","created_at","server_time"].every(key=>uint(row[key]))
      || !["active","retiring","released"].includes(row.state as string))return false;
    previous=row.binding_id;
  }
  return !data.has_more || (data.items.length===100 && data.next_cursor===previous);
}
