import { decodeBase64url, decodeEnrollmentPageCursor } from "@licensecc/licensing-domain/lease/device_protocol";
function validPageCursor(value: unknown): boolean {
  if(value===null)return true;
  try {decodeEnrollmentPageCursor(value);return true;}catch{return false;}
}
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && !Object.is(v,-0);
const text = (v: unknown): v is string => typeof v === "string" && v.length <= 2048;
function exact(v: unknown, keys: string[]): v is Record<string,unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k=>Object.hasOwn(v,k));
}

export function validConsentResponse(operation: "inspect" | "approve" | "deny", data: unknown): boolean {
  if (operation === "deny") return exact(data,["status","revision"]) && data.status === "authorization_denied" && uint(data.revision);
  if (operation === "approve") {
    if (!exact(data,["callback_url","expires_at","revision"]) || !text(data.callback_url) || !uint(data.expires_at) || !uint(data.revision)) return false;
    try {
      const url=new URL(data.callback_url);
      return url.href===data.callback_url && url.protocol==="http:" && ["127.0.0.1","[::1]"].includes(url.hostname)
        && Number(url.port)>0 && url.username==="" && url.password==="" && !data.callback_url.includes("#")
        && Array.from(url.searchParams.keys()).sort().join(",")==="code,state"
        && decodeBase64url(url.searchParams.get("code")??"",32).length===32 && decodeBase64url(url.searchParams.get("state")??"",32).length===32;
    } catch {return false;}
  }
  return exact(data,["app","device","status","revision","expires_at","entitlements","has_more","next_page_cursor","comparison_code"])
    && exact(data.app,["name","project"]) && text(data.app.name) && text(data.app.project)
    && exact(data.device,["label"]) && text(data.device.label)
    && ["pending","approved","consumed","denied"].includes(data.status as string)
    && uint(data.revision) && uint(data.expires_at) && typeof data.has_more==="boolean"
    && typeof data.comparison_code==="string" && /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(data.comparison_code)
    && validPageCursor(data.next_page_cursor)
    && data.has_more===(data.next_page_cursor!==null)
    && (data.status==="pending" || (data.next_page_cursor===null && Array.isArray(data.entitlements) && data.entitlements.length===0))
    && Array.isArray(data.entitlements) && data.entitlements.length<=100
    && (!data.has_more || data.entitlements.length===100)
    && data.entitlements.every(e=>(exact(e,["id","feature","valid_until","device_limit"])
      || (exact(e,["id","feature","valid_until","device_limit","activation_trial_seconds"])
        && uint(e.activation_trial_seconds) && e.activation_trial_seconds>=2))
      && text(e.id) && text(e.feature) && (e.valid_until===null || uint(e.valid_until)) && uint(e.device_limit))
    && new Set(data.entitlements.map(e=>e.id)).size===data.entitlements.length;
}
