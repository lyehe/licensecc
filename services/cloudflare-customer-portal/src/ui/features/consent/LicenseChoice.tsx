import React from "react";
import { decodeEntitlementId } from "@licensecc/licensing-domain/entitlements/contracts";
import { formatEpoch } from "../../portalWorkflow";
import type { ConsentInspection } from "../../shared/consentApi";

const reference=(id:string):string=>decodeEntitlementId(id)?.license_fingerprint??id;
const duration=(seconds:number):string=>{
  for(const [size,unit] of [[86400,"day"],[3600,"hour"],[60,"minute"],[1,"second"]] as const){
    if(seconds%size===0){const n=seconds/size;return `${n} ${unit}${n===1?"":"s"}`;}
  }
  return `${seconds} seconds`;
};

const licenseOptionLabel=(item:ConsentInspection["entitlements"][0]):string=>{
  const expiry=item.valid_until===null?"never":formatEpoch(item.valid_until);
  const usage=`${item.devices_in_use}/${item.device_limit}`;
  const label=`${item.feature} · expires ${expiry} · ${usage} device${item.device_limit===1?"":"s"}`;
  return item.device_connected?`${label} · this device`:label;
};

export function LicenseChoice({items,selected,onSelect,busy,soleOverall}:{items:ConsentInspection["entitlements"];selected:string;onSelect(value:string):void;busy:boolean;soleOverall:boolean}):React.ReactElement {
  const chosen=items.find(item=>item.id===selected);
  return <>
    {items.length>0 && !soleOverall && <label className="consentChoice">License<select value={selected} onChange={event=>onSelect(event.target.value)} disabled={busy}>
      <option value="" disabled>Choose a license</option>
      {items.map((item)=><option key={item.id} value={item.id}>{licenseOptionLabel(item)}</option>)}
    </select></label>}
    {chosen && <dl className="consentSummary consentLicense">
      {soleOverall && <div><dt>License</dt><dd>{chosen.feature}</dd></div>}
      <div><dt>Device limit</dt><dd>{chosen.devices_in_use} of {chosen.device_limit} {chosen.device_limit===1?"device":"devices"} in use</dd></div>
      {chosen.activation_trial_seconds!==undefined && <div><dt>Trial</dt><dd>{duration(chosen.activation_trial_seconds)} from app activation. Approving here does not start the trial.</dd></div>}
      {(chosen.activation_trial_seconds===undefined || chosen.valid_until!==null) && <div><dt>{chosen.activation_trial_seconds===undefined?"Expires":"Expires by"}</dt><dd>{chosen.valid_until===null?"No expiry":formatEpoch(chosen.valid_until)}</dd></div>}
    </dl>}
    {chosen?.device_connected && <p className="consentConnected">This device is already connected to this license.</p>}
    {chosen && <details className="referenceDetails consentReference"><summary>License details</summary><span className="identifier">{reference(chosen.id)}</span></details>}
  </>;
}
