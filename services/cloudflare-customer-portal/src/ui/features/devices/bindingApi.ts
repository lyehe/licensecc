import { validBindingPage,validRetirement,type BindingPage,type Retirement } from "../../../shared/bindings";
import { matchesDeviceSearch } from "../../../shared/deviceSearch";
import { protectedDeviceRequest, type ProtectedDeviceResult } from "../../shared/protectedDeviceRequest";
const errors:Record<string,number>={invalid_request:400,unauthorized:401,cross_site_forbidden:403,access_denied:403,binding_unavailable:404,
  account_changed:409,revision_conflict:409,idempotency_conflict:409,rate_limited:429,config_error:503,temporarily_unavailable:503};
function request<T>(path:string,customer:string,validate:(data:unknown)=>data is T,body?:Record<string,unknown>,key?:string):Promise<ProtectedDeviceResult<T>> {
  return protectedDeviceRequest({
    path,
    customerId: customer,
    method: body ? "POST" : "GET",
    ...(body ? { body, idempotencyKey: key } : {}),
    successCode: body ? "binding_retired" : "device_bindings",
    failureStatuses: errors,
    validate,
  });
}
export const readBindings=(customer:string,cursor="",query="",project:string|null=null)=>{
  const params=new URLSearchParams();if(cursor)params.set("cursor",cursor);if(query.trim())params.set("q",query.trim());if(project!==null)params.set("project",project);
  return request<BindingPage>("/api/portal/device-bindings"+(params.size?"?"+params:""),customer,(data):data is BindingPage=>validBindingPage(data,customer,cursor,query) && data.items.every(row=>matchesDeviceSearch([row.label||"Unnamed device",row.binding_id],row.project,query,project)));
};
export const readBinding=(customer:string,binding:string)=>request<BindingPage>("/api/portal/device-bindings?binding_id="+encodeURIComponent(binding),customer,(data):data is BindingPage=>validBindingPage(data,customer,"") && !data.has_more && data.items.length<=1 && data.items.every(row=>row.binding_id===binding));
export const retireBinding=(customer:string,body:Record<string,unknown>,key:string)=>request<Retirement>("/api/portal/device-bindings/retire",customer,(data):data is Retirement=>validRetirement(data,body),body,key);
