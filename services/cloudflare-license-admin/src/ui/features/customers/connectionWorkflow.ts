import { api, parseExactApiSuccess } from '../../shared/api';

export type Operator={subject:string;actor_type:'access'|'dev';role:'reader'|'admin'};
export type Connection={binding_id:string;project:string;feature:string;license_fingerprint:string;label:string;state:'active'|'retiring'|'released';generation:number;revision:number;hold_until:number;last_proof_at:number;created_at:number};
export type BindingEvent={id:number;event_type:'exchange'|'renew'|'retire';actor:string;occurred_at:number};
export type Context={customer:{id:string;status:'active'|'disabled'};operator:Operator;server_time:number};
export type Page=Context&{items:Connection[];next_cursor:string|null};
export type History=Context&{binding_id:string;items:BindingEvent[];next_cursor:string|null};
export type Pending={customer:string;binding:string;revision:number;key:string;operator:Operator;label:string;project:string;feature:string;hold:number};
type Retirement={binding_id:string;state:'retiring';revision:number;generation:number;effective_release_at:number};
type Result<T>={ok:true;data:T}|{ok:false;code:string};
const record=(v:unknown):v is Record<string,unknown>=>!!v && typeof v==='object' && !Array.isArray(v);
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).sort().join(',')===expected.sort().join(',');
const integer=(v:unknown):v is number=>Number.isSafeInteger(v) && Number(v)>=0 && !Object.is(v,-0);
export function canonicalId(v:unknown,bytes:number):v is string {
  if(typeof v!=='string' || !/^[A-Za-z0-9_-]+$/.test(v))return false;
  try{const decoded=atob(v.replaceAll('-','+').replaceAll('_','/'));return decoded.length===bytes && btoa(decoded).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')===v;}catch{return false;}
}
export const operatorKey=(operator:Operator)=>encodeURIComponent(JSON.stringify([operator.actor_type,operator.subject]));
const validOperator=(v:unknown):v is Operator=>record(v) && Object.keys(v).sort().join(',')==='actor_type,role,subject' && typeof v.subject==='string' && v.subject.length>0 && v.subject.length<=256
  && Array.from(v.subject).every(character=>character.charCodeAt(0)>=32 && character.charCodeAt(0)!==127) && new TextDecoder().decode(new TextEncoder().encode(v.subject))===v.subject
  && typeof v.actor_type==='string' && ['access','dev'].includes(v.actor_type) && typeof v.role==='string' && ['reader','admin'].includes(v.role);
function context(v:unknown,customer:string):v is Context & Record<string,unknown> {
  return record(v) && record(v.customer) && keys(v.customer,['id','status']) && v.customer.id===customer && typeof v.customer.status==='string' && ['active','disabled'].includes(v.customer.status) && validOperator(v.operator) && integer(v.server_time);
}
function connection(v:unknown):v is Connection {
  return record(v) && keys(v,['binding_id','project','feature','license_fingerprint','label','state','generation','revision','hold_until','last_proof_at','created_at']) && canonicalId(v.binding_id,16) && ['project','feature','license_fingerprint','label'].every(k=>typeof v[k]==='string')
    && typeof v.state==='string' && ['active','retiring','released'].includes(v.state) && ['generation','revision','hold_until','last_proof_at','created_at'].every(k=>integer(v[k])) && Number(v.generation)>=1;
}
export function validPage(v:unknown,customer:string,cursor='',exact?:string):v is Page {
  if(!record(v) || !keys(v,['customer','operator','server_time','items','next_cursor']) || !context(v,customer) || !Array.isArray(v.items) || v.items.length>100 || !v.items.every(connection))return false;
  let previous=cursor;for(const row of v.items){if(row.binding_id<=previous || (exact && row.binding_id!==exact)
    || (row.state==='retiring' && row.hold_until<=v.server_time) || (row.state==='released' && row.hold_until>v.server_time))return false;previous=row.binding_id;}
  return exact ? v.items.length<=1 && v.next_cursor===null : v.next_cursor===null || (v.items.length===100 && v.next_cursor===previous && canonicalId(v.next_cursor,16));
}
function validHistory(v:unknown,customer:string,binding:string,cursor:string):v is History {
  if(!record(v) || !keys(v,['customer','operator','server_time','binding_id','items','next_cursor']) || !context(v,customer) || v.binding_id!==binding || !Array.isArray(v.items) || v.items.length>100)return false;
  let previous=Number(cursor||0);
  for(const item of v.items){if(!record(item) || !keys(item,['id','event_type','actor','occurred_at']) || !integer(item.id) || item.id<=previous || !integer(item.occurred_at) || typeof item.actor!=='string' || typeof item.event_type!=='string' || !['exchange','renew','retire'].includes(item.event_type))return false;previous=item.id;}
  return v.next_cursor===null || (v.items.length===100 && v.next_cursor===String(previous));
}
const failures:Record<string,number>={invalid_request:400,missing_access_jwt:401,admin_auth_not_configured:401,invalid_access_jwt:403,admin_role_denied:403,admin_role_required:403,
  cross_site_mutation_forbidden:403,access_denied:403,not_found:404,binding_unavailable:404,operator_changed:409,revision_conflict:409,idempotency_conflict:409,temporarily_unavailable:503};
async function request<T>(path:string,code:string,guard:(v:unknown)=>boolean,pending?:Pending):Promise<Result<T>> {
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
  try{
    const response=await api<T>(path,{method:pending?'POST':'GET',cache:'no-store',credentials:'same-origin',redirect:'error',signal:abort.signal,
      ...(pending?{headers:{'x-expected-operator':operatorKey(pending.operator),'idempotency-key':pending.key},body:JSON.stringify({expected_revision:pending.revision})}:{})});
    const parsed=parseExactApiSuccess<T>(response,code,guard);if(parsed)return {ok:true,data:parsed.data};
    if(response.ok===false && typeof response.code==='string' && typeof response.request_id==='string' && response.request_id.trim() && Object.hasOwn(failures,response.code)
      && (code!=='binding_retired' || response.code!=='not_found') && failures[response.code]===response.__httpStatus)return {ok:false,code:response.code};
  }catch{/* Unconfirmed transport or malformed data retains the pending operation. */}finally{clearTimeout(timer);}
  return {ok:false,code:'temporarily_unavailable'};
}
const root=(customer:string)=>`/api/admin/customers/${encodeURIComponent(customer)}/bindings`;
export const readConnections=(customer:string,cursor='',exact?:string)=>request<Page>(root(customer)+(exact?'?binding_id='+encodeURIComponent(exact):cursor?'?cursor='+encodeURIComponent(cursor):''),'customer_bindings',v=>validPage(v,customer,cursor,exact));
export const readHistory=(customer:string,binding:string,cursor='')=>request<History>(`${root(customer)}/${binding}/events`+(cursor?'?cursor='+cursor:''),'binding_events',v=>validHistory(v,customer,binding,cursor));
export const retireConnection=(pending:Pending)=>request<Retirement>(`${root(pending.customer)}/${pending.binding}/retire`,'binding_retired',v=>record(v)
  && Object.keys(v).sort().join(',')==='binding_id,effective_release_at,generation,revision,state' && v.binding_id===pending.binding && v.state==='retiring'
  && v.revision===pending.revision+1 && integer(v.generation) && v.generation>=2 && integer(v.effective_release_at),pending);
const storageKey=(customer:string)=>'licensecc.admin-retirement.v1:'+encodeURIComponent(customer);
export function restorePending(customer:string):Pending|'invalid'|null {
  try{const raw=sessionStorage.getItem(storageKey(customer));if(raw===null)return null;const v:unknown=JSON.parse(raw);
    if(!record(v) || Object.keys(v).sort().join(',')!=='binding,customer,feature,hold,key,label,operator,project,revision' || v.customer!==customer || !canonicalId(v.binding,16) || !canonicalId(v.key,32)
      || !integer(v.revision) || v.revision>=Number.MAX_SAFE_INTEGER || !integer(v.hold) || !validOperator(v.operator) || v.operator.role!=='admin'
      || !['label','project','feature'].every(k=>typeof v[k]==='string'))return 'invalid';return v as Pending;
  }catch{return 'invalid';}
}
export function savePending(pending:Pending):boolean {try{const value=JSON.stringify(pending);sessionStorage.setItem(storageKey(pending.customer),value);return sessionStorage.getItem(storageKey(pending.customer))===value;}catch{return false;}}
export function clearPending(customer:string):boolean {try{sessionStorage.removeItem(storageKey(customer));return sessionStorage.getItem(storageKey(customer))===null;}catch{return false;}}
export function createPending(customer:string,row:Connection,operator:Operator):Pending {
  const bytes=crypto.getRandomValues(new Uint8Array(32));const key=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  return {customer,binding:row.binding_id,revision:row.revision,key,operator:{...operator},label:row.label||'Unnamed connection',project:row.project,feature:row.feature,hold:row.hold_until};
}
