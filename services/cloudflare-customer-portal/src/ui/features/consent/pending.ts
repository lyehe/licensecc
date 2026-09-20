import { decodeBase64url } from "@licensecc/licensing-domain/lease/device_protocol";

const STORAGE_KEY = "licensecc.enrollment.v1";
export type PendingMutation = { operation: "approve" | "deny"; key: string; revision: number; entitlementId?: string; comparisonCode?:string };
export type PendingEnrollment = { handle: string; createdAt: number; customerId?: string; mutation?: PendingMutation };
export type EnrollmentEntry = PendingEnrollment | "invalid" | "storage_unavailable" | null;
const handleValid = (value: unknown): value is string => {
  try { return typeof value === "string" && decodeBase64url(value,32).length === 32; } catch {return false;}
};
const objectWithKeys = (value: unknown, allowed: string[]): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));

export function clearEnrollment(browser: Window = window): void {
  try {browser.sessionStorage.removeItem(STORAGE_KEY);} catch { /* no persistent fallback */ }
}
export function saveEnrollment(value: PendingEnrollment, browser: Window = window): boolean {
  try {browser.sessionStorage.setItem(STORAGE_KEY,JSON.stringify(value));return true;} catch {return false;}
}

// Called before auth hooks/render. Never put a handle in a query, login return URL,
// DOM attribute, localStorage, analytics event or history entry.
export function captureEnrollment(browser: Window = window): EnrollmentEntry {
  const url = new URL(browser.location.href), fragment = new URLSearchParams(url.hash.slice(1));
  const supplied = fragment.has("attempt_handle") || url.searchParams.has("attempt_handle");
  if (supplied || (url.pathname==="/connect" && url.hash!=="")) {
    const value = fragment.get("attempt_handle");
    const valid = !url.searchParams.has("attempt_handle") && [...fragment.keys()].length === 1 && handleValid(value);
    url.hash="";url.searchParams.delete("attempt_handle");
    browser.history.replaceState(null,"",url.pathname+url.search);
    if (!valid || !value) {clearEnrollment(browser);return "invalid";}
    const existing=restoreEnrollment(browser);
    if(existing && typeof existing!=="string" && existing.handle===value)return existing;
    clearEnrollment(browser);
    const pending = {handle:value,createdAt:Date.now()};
    return saveEnrollment(pending,browser) ? pending : "storage_unavailable";
  }
  return restoreEnrollment(browser) ?? (url.pathname==="/connect" ? "invalid" : null);
}

function restoreEnrollment(browser:Window):EnrollmentEntry {
  try {
    const raw=browser.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved:unknown=JSON.parse(raw);
    if (!objectWithKeys(saved,["handle","createdAt","customerId","mutation"]) || !handleValid(saved.handle)
        || typeof saved.createdAt!=="number" || !Number.isSafeInteger(saved.createdAt)
        || (saved.customerId!==undefined && (typeof saved.customerId!=="string" || saved.customerId.length===0 || saved.customerId.length>256))) throw new Error("invalid");
    const age=Date.now()-saved.createdAt;
    if(age<0 || age>=300000)throw new Error("invalid");
    const m=saved.mutation;
    if(m!==undefined && typeof saved.customerId!=="string")throw new Error("invalid");
    if (m!==undefined && (!objectWithKeys(m,["operation","key","revision","entitlementId","comparisonCode"]) || !["approve","deny"].includes(m.operation as string)
        || typeof m.key!=="string" || !/^[A-Za-z0-9_-]{16,128}$/.test(m.key)
        || typeof m.revision!=="number" || !Number.isSafeInteger(m.revision) || Object.is(m.revision,-0) || m.revision<0 || m.revision>=Number.MAX_SAFE_INTEGER
        || (m.operation==="approve" ? typeof m.entitlementId!=="string" || m.entitlementId.length===0 || m.entitlementId.length>2048
          || typeof m.comparisonCode!=="string" || !/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(m.comparisonCode)
          : m.entitlementId!==undefined || m.comparisonCode!==undefined))) throw new Error("invalid");
    return saved as PendingEnrollment;
  } catch {clearEnrollment(browser);return "invalid";}
}
