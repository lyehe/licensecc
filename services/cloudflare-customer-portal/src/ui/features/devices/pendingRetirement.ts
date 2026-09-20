import { canonicalId } from "../../../shared/bindings";
export type PendingRetirement={customer:string;binding:string;revision:number;key:string;label:string;project:string;feature:string;hold:number};
const storageKey=(customer:string)=>"licensecc.retirement.v1:"+encodeURIComponent(customer);
export function restoreRetirement(customer:string):PendingRetirement|"invalid"|null {
  try {
    const raw=sessionStorage.getItem(storageKey(customer));if(!raw)return null;
    const value=JSON.parse(raw) as PendingRetirement;
    if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).sort().join(',')!=="binding,customer,feature,hold,key,label,project,revision"
      || typeof value.customer!=="string" || !canonicalId(value.binding,16) || !canonicalId(value.key,32)
      || !Number.isSafeInteger(value.revision) || value.revision<0 || Object.is(value.revision,-0) || value.revision>=Number.MAX_SAFE_INTEGER
      || ![value.label,value.project,value.feature].every(text=>typeof text==="string") || !Number.isSafeInteger(value.hold) || value.hold<0) return "invalid";
    return value.customer===customer?value:"invalid";
  }catch{return "invalid";}
}
export function saveRetirement(value:PendingRetirement):boolean {
  try{sessionStorage.setItem(storageKey(value.customer),JSON.stringify(value));return sessionStorage.getItem(storageKey(value.customer))===JSON.stringify(value);}catch{return false;}
}
export function clearRetirement(customer:string):boolean {
  try{sessionStorage.removeItem(storageKey(customer));return sessionStorage.getItem(storageKey(customer))===null;}catch{return false;}
}
