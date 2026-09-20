import { readUnsignedJson, UnsignedJsonError } from "@licensecc/cloudflare-runtime/http/unsigned_json";
import { portalRateLimit } from "../../auth/portal_ratelimit.mjs";
import { envelope } from "../support.js";
import type { Env, SessionRow } from "../env.js";
import { validConsentResponse } from "../../shared/consent.js";
import { decodeBase64url } from "@licensecc/licensing-domain/lease/device_protocol";
import { validRetirement } from "../../shared/bindings.js";

type Operation = "inspect" | "approve" | "deny" | "retire";
type ConsentRpc = Record<Operation, (customerId: string, input: unknown) => Promise<{ok: boolean; status: number; code: string; data?: unknown}>>;
const successCodes = { inspect: "authorization_inspected", approve: "authorization_approved", deny: "authorization_denied", retire: "binding_retired" };
const errors: Record<string, number> = { invalid_request:400, access_denied:403, authorization_unavailable:404,
  revision_conflict:409, idempotency_conflict:409, authorization_expired:410, binding_unavailable:404, temporarily_unavailable:503 };

export async function consentRoute(request: Request, env: Env, session: SessionRow, reqId: string, now: number, operation: Operation) {
  const respond = (code: string, status: number, data?: unknown) => envelope(reqId,code,data,status,{"cache-control":"no-store"});
  const origin = env.PORTAL_PUBLIC_ORIGIN?.replace(/\/$/, "");
  if (!origin) return respond("temporarily_unavailable",503);
  try {
    const configured = new URL(origin);
    if (configured.protocol!=="https:" || configured.origin!==origin) return respond("temporarily_unavailable",503);
  } catch {return respond("temporarily_unavailable",503);}
  if (request.headers.get("origin") !== origin || ![null,"same-origin","none"].includes(request.headers.get("sec-fetch-site"))) return respond("cross_site_forbidden",403);
  if (request.url.includes("?") || request.url.includes("#")) return respond("invalid_request",400);
  // This is a displayed-account precondition, never an authority source.
  const expectedCustomer = request.headers.get("x-expected-customer-id");
  if (!expectedCustomer) return respond("invalid_request",400);
  if (expectedCustomer !== encodeURIComponent(session.customer_id)) return respond("account_changed",409);
  if (!env.DEVICE_CONSENT) return respond("temporarily_unavailable",503);
  // Fixed global budget runs first so arbitrary identities cannot grow counters after denial.
  for (const [key,limit] of [["device-consent:global",1000],[`device-consent:customer:${session.customer_id}`,20]] as const) {
    const rate = await portalRateLimit(env,key,limit,60,now);
    if (rate.limited || !Number.isSafeInteger(rate.count) || rate.count < 1) return envelope(reqId,"rate_limited",undefined,429,{"cache-control":"no-store","retry-after":"60"});
  }
  try {
    const body = await readUnsignedJson(request);
    const fields = operation === "retire" ? ["binding_id","expected_revision"] : operation === "inspect" ? ["attempt_handle",...(Object.hasOwn(body,"page_cursor")?["page_cursor"]:[])] : operation === "approve"
      ? ["attempt_handle","entitlement_id","expected_attempt_revision"] : ["attempt_handle","expected_attempt_revision"];
    if (Object.keys(body).length !== fields.length || fields.some(field=>!Object.hasOwn(body,field))) return respond("invalid_request",400);
    if(Object.hasOwn(body,"page_cursor") && (typeof body.page_cursor!=="string" || !/^[A-Za-z0-9_-]{1,512}$/.test(body.page_cursor)))return respond("invalid_request",400);
    if (operation !== "inspect") {
      const key = request.headers.get("idempotency-key");
      if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) return respond("invalid_request",400);
      if(operation==="retire") {
        if(typeof body.binding_id!=="string")return respond("invalid_request",400);
        try { if(decodeBase64url(key,32).length!==32 || decodeBase64url(body.binding_id,16).length!==16)return respond("invalid_request",400); }
        catch { return respond("invalid_request",400); }
        if(!Number.isSafeInteger(body.expected_revision) || Object.is(body.expected_revision,-0)
            || (body.expected_revision as number)<0 || (body.expected_revision as number)>=Number.MAX_SAFE_INTEGER) return respond("invalid_request",400);
      }
      body.operation_id = key;
    }
    const rpc = env.DEVICE_CONSENT as unknown as ConsentRpc;
    const result = await rpc[operation](session.customer_id,body);
    if (result?.ok === true && result.status === 200 && result.code === successCodes[operation]
        && (operation==="retire" ? validRetirement(result.data,body) : validConsentResponse(operation,result.data))) return respond(result.code,200,result.data);
    if (result?.ok === false && typeof result.code === "string" && Object.hasOwn(errors,result.code)
        && (operation==="retire" ? !["authorization_unavailable","authorization_expired"].includes(result.code) : result.code!=="binding_unavailable")
        && typeof result.status === "number" && errors[result.code] === result.status) return respond(result.code,result.status);
    return respond("temporarily_unavailable",503);
  } catch (error) {
    return respond(error instanceof UnsignedJsonError ? "invalid_request" : "temporarily_unavailable",error instanceof UnsignedJsonError ? 400 : 503);
  }
}

export const CONSENT_DISPATCH = {
  "POST /api/portal/device-bindings/retire": (r: Request,e: Env,s: SessionRow,id: string,n: number) => consentRoute(r,e,s,id,n,"retire"),
  "POST /api/portal/device-authorizations/inspect": (r: Request,e: Env,s: SessionRow,id: string,n: number) => consentRoute(r,e,s,id,n,"inspect"),
  "POST /api/portal/device-authorizations/approve": (r: Request,e: Env,s: SessionRow,id: string,n: number) => consentRoute(r,e,s,id,n,"approve"),
  "POST /api/portal/device-authorizations/deny": (r: Request,e: Env,s: SessionRow,id: string,n: number) => consentRoute(r,e,s,id,n,"deny"),
};
