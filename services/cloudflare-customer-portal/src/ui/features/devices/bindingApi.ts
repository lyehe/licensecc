import { validBindingPage,validRetirement,type BindingPage,type Retirement } from "../../../shared/bindings";
type Result<T>={ok:true;data:T}|{ok:false;code:string;retryAfter?:number};
const errors:Record<string,number>={invalid_request:400,unauthorized:401,cross_site_forbidden:403,access_denied:403,binding_unavailable:404,
  account_changed:409,revision_conflict:409,idempotency_conflict:409,rate_limited:429,config_error:503,temporarily_unavailable:503};
async function request<T>(path:string,customer:string,validate:(data:unknown)=>data is T,body?:Record<string,unknown>,key?:string):Promise<Result<T>> {
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
  try {
    const response=await fetch(path,{method:body?"POST":"GET",credentials:"same-origin",cache:"no-store",redirect:"error",signal:controller.signal,
      headers:{"x-expected-customer-id":encodeURIComponent(customer),...(body?{"content-type":"application/json","idempotency-key":key!}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();
    if(response.status===200 && result?.ok===true && result.code===(body?"binding_retired":"device_bindings") && validate(result.data))return {ok:true,data:result.data};
    if(result?.ok===false && typeof result.code==="string" && Object.hasOwn(errors,result.code) && errors[result.code]===response.status)
      return {ok:false,code:result.code,...(response.status===429?{retryAfter:Math.min(300,Math.max(60,Number(response.headers.get("retry-after"))||60))}:{})};
  }catch{/* A lost response cannot prove that the retirement failed. */}
  finally{clearTimeout(timeout);}
  return {ok:false,code:"temporarily_unavailable"};
}
export const readBindings=(customer:string,cursor="")=>request<BindingPage>("/api/portal/device-bindings"+(cursor?"?cursor="+encodeURIComponent(cursor):""),customer,(data):data is BindingPage=>validBindingPage(data,customer,cursor));
export const readBinding=(customer:string,binding:string)=>request<BindingPage>("/api/portal/device-bindings?binding_id="+encodeURIComponent(binding),customer,(data):data is BindingPage=>validBindingPage(data,customer,"") && !data.has_more && data.items.length<=1 && data.items.every(row=>row.binding_id===binding));
export const retireBinding=(customer:string,body:Record<string,unknown>,key:string)=>request<Retirement>("/api/portal/device-bindings/retire",customer,(data):data is Retirement=>validRetirement(data,body),body,key);
