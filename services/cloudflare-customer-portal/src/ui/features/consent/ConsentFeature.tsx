import React, { useEffect, useRef, useState } from "react";
import { consentApi, type ConsentApproval, type ConsentInspection } from "../../shared/consentApi";
import { useSingleFlight } from "../../shared/useSingleFlight";
import { clearEnrollment, saveEnrollment, type EnrollmentEntry, type PendingEnrollment, type PendingMutation } from "./pending";
import { LicenseChoice } from "./LicenseChoice";

export function ConsentFeature({entry,customerId,onDone,onSignOut,onSessionExpired,feedback}: {
  entry: Exclude<EnrollmentEntry,null>; customerId:string; onDone():void; onSignOut():Promise<void>; onSessionExpired():Promise<boolean>; feedback?:React.ReactNode;
}):React.ReactElement {
  const record=useRef<PendingEnrollment|null>(typeof entry==="string"?null:entry);
  const [details,setDetails]=useState<ConsentInspection|null>(null);
  const [selected,setSelected]=useState(record.current?.mutation?.entitlementId??"");
  const [pageCursor,setPageCursor]=useState<string|undefined>();
  const [previousCursors,setPreviousCursors]=useState<Array<string|undefined>>([]);
  const [comparisonConfirmed,setComparisonConfirmed]=useState(false);
  const [phase,setPhase]=useState<"loading"|"ready"|"approved"|"cancelled"|"connected"|"expired"|"blocked">(entry==="invalid"?"expired":entry==="storage_unavailable"?"blocked":"loading");
  const [message,setMessage]=useState(entry==="storage_unavailable"?"Browser session storage is unavailable. Enable it, then restart from your app.":"");
  const [callback,setCallback]=useState<string|null>(null);
  const [deadline,setDeadline]=useState<number|null>(null);
  const [retryAt,setRetryAt]=useState(0),[clock,setClock]=useState(Date.now);
  const {busy,runOnce}=useSingleFlight();
  const mounted=useRef(true);
  const heading=useRef<HTMLHeadingElement>(null);

  function expire():void {
    clearEnrollment();record.current=null;setCallback(null);setDeadline(null);setPhase("expired");setMessage("");
  }

  function failure(code:string,retryAfter?:number):void {
    if(retryAfter)setRetryAt(Date.now()+retryAfter*1000);
    if (code==="unauthorized") {void onSessionExpired();return;}
    if (code==="account_changed") {clearEnrollment();setPhase("blocked");setMessage("Your account changed. Start a new connection from your app.");return;}
    if (["invalid_request","cross_site_forbidden"].includes(code)) {clearEnrollment();setPhase("blocked");setMessage("This connection request cannot be submitted. Restart from your app; contact your administrator if it happens again.");return;}
    if (["authorization_expired","authorization_unavailable"].includes(code)) {expire();return;}
    if (["access_denied","revision_conflict","idempotency_conflict"].includes(code)) {
      setPhase("blocked");setMessage(code==="access_denied"?"This account cannot approve this request.":"This request changed. Return to your app to check its connection.");return;
    }
    setMessage(code==="rate_limited"?"Too many attempts. Wait a minute before trying again.":record.current?.mutation?"We couldn’t confirm the result. Retry to check the same request safely.":"We couldn’t load this request. Please try again.");
  }

  async function inspect(cursor?:string,history:Array<string|undefined>=[]):Promise<void> {
    const current=record.current;if(!current)return;
    if(current.customerId && current.customerId!==customerId){clearEnrollment();setPhase("blocked");setMessage("Your account changed. Start a new connection from your app.");return;}
    current.customerId=customerId;
    if(!saveEnrollment(current)){setPhase("blocked");setMessage("Browser session storage is unavailable. Enable it, then restart from your app.");return;}
    const result=await consentApi<ConsentInspection>("inspect",{attempt_handle:current.handle,...(cursor===undefined?{}:{page_cursor:cursor})},customerId);
    if(!mounted.current || record.current!==current)return;
    if(!result.ok){setPhase("ready");failure(result.code,result.retryAfter);return;}
    if(result.data.next_page_cursor!==null && (result.data.next_page_cursor===cursor || history.includes(result.data.next_page_cursor))){setPhase("ready");setMessage("We couldn’t load the next page safely. Go back and refresh the list.");return;}
    if((details && details.comparison_code!==result.data.comparison_code) || (current.mutation?.operation==="approve" && current.mutation.comparisonCode!==result.data.comparison_code)){
      clearEnrollment();setPhase("blocked");setMessage("This connection request changed. Restart from your app.");return;
    }
    setDetails(result.data);setMessage("");setPageCursor(cursor);setPreviousCursors(history);
    if(result.data.status==="consumed" || result.data.status==="denied") {
      clearEnrollment();setDeadline(null);setPhase(result.data.status==="consumed"?"connected":"cancelled");return;
    }
    if(Date.now()>=result.data.expires_at*1000){expire();return;}
    setDeadline(result.data.expires_at*1000);
    if(result.data.status==="approved" && current.mutation?.operation!=="approve") {
      setPhase("blocked");setMessage("This request was already approved. Return to your app to finish connecting.");return;
    }
    if(!current.mutation)setSelected(cursor===undefined && history.length===0 && result.data.next_page_cursor===null && result.data.entitlements.length===1?result.data.entitlements[0]!.id:"");
    setPhase("ready");
  }

  useEffect(()=>{
    mounted.current=true;
    if(record.current)void runOnce(inspect);
    return()=>{mounted.current=false;};
  },[]);
  useEffect(()=>{heading.current?.focus();},[phase]);
  useEffect(()=>{
    if(deadline===null && !retryAt)return;
    const tick=():void=>{
      const now=Date.now();setClock(now);
      if(retryAt && now>=retryAt)setRetryAt(0);
      if(deadline!==null && now>=deadline)expire();
    };
    const timer=setInterval(tick,1000);
    document.addEventListener("visibilitychange",tick);window.addEventListener("pageshow",tick);tick();
    return()=>{clearInterval(timer);document.removeEventListener("visibilitychange",tick);window.removeEventListener("pageshow",tick);};
  },[deadline,retryAt]);

  async function act(operation:"approve"|"deny"):Promise<void> {
    await runOnce(async()=>{
      const current=record.current;if(!current || !details)return;
      if(deadline!==null && Date.now()>=deadline){expire();return;}
      if(!current.mutation && operation==="approve" && (!comparisonConfirmed || !selected))return;
      const mutation:PendingMutation=current.mutation??{operation,key:crypto.randomUUID(),revision:details.revision,...(operation==="approve"?{entitlementId:selected,comparisonCode:details.comparison_code}:{})};
      current.mutation=mutation;
      if(!saveEnrollment(current)){setPhase("blocked");setMessage("Unable to save this request safely. Restart from your app.");return;}
      setMessage("");
      const result=await consentApi<ConsentApproval>(mutation.operation,{attempt_handle:current.handle,expected_attempt_revision:mutation.revision,
        ...(mutation.operation==="approve"?{entitlement_id:mutation.entitlementId}:{})},customerId,mutation.key);
      if(!mounted.current || record.current!==current)return;
      if(!result.ok){failure(result.code,result.retryAfter);return;}
      if(mutation.operation==="deny"){clearEnrollment();setDeadline(null);setPhase("cancelled");return;}
      if(Date.now()>=result.data.expires_at*1000){expire();return;}
      setDeadline(result.data.expires_at*1000);
      setCallback(result.data.callback_url);setPhase("approved");
      // Keep only the immutable retry intent in sessionStorage until consumed or expired.
      // The short-lived callback code stays in memory and is sent only to loopback.
      window.location.assign(result.data.callback_url);
    });
  }

  const mutation=record.current?.mutation;
  const waiting=clock<retryAt;
  const terminal=["expired","blocked","cancelled","connected"].includes(phase);
  const title=phase==="expired"?"Connection request expired":phase==="cancelled"?"Connection cancelled":phase==="connected"?"Device connected":phase==="approved"?"Returning to your app…":phase==="blocked"?"Unable to connect":"Connect this device";
  return <main className="authPane consentPane"><div className="authBrand brand"><span aria-hidden="true">L</span>Licensecc</div>
    <section className="authCard consentCard" aria-busy={busy}>
      <h1 ref={heading} tabIndex={-1}>{title}</h1>
      {feedback}
      {phase==="loading"?<p role="status">Checking this connection request…</p>:<>
        {details && !terminal && <div className="consentIdentity"><strong>{details.app.name}</strong><span>{details.device.label||"Unnamed device"}</span></div>}
        {phase==="ready" && details && !mutation && <>
          {details.entitlements.length>0 && <div className="consentComparison"><p>Check the code in your app</p><p className="consentCode">{details.comparison_code}</p>
            <label className="consentConfirm"><input type="checkbox" checked={comparisonConfirmed} onChange={event=>setComparisonConfirmed(event.target.checked)} disabled={busy} />This code matches my app</label></div>}
          {details.entitlements.length===0?<p>{previousCursors.length?"No licenses remain on this page. Go back to choose another license.":"No eligible license is available for this app. Contact your administrator."}</p>:
            <LicenseChoice items={details.entitlements} selected={selected} onSelect={setSelected} busy={busy} soleOverall={pageCursor===undefined && !details.has_more && details.entitlements.length===1} />}
          {(previousCursors.length>0 || details.has_more) && <nav className="consentPages" aria-label="License pages">
            <button disabled={busy||waiting||previousCursors.length===0} onClick={()=>void runOnce(()=>inspect(previousCursors.at(-1),previousCursors.slice(0,-1)))}>Previous</button>
            <span role="status">Page {previousCursors.length+1}</span><button disabled={busy||waiting||!details.next_page_cursor} onClick={()=>void runOnce(()=>inspect(details.next_page_cursor??undefined,[...previousCursors,pageCursor]))}>Next</button>
          </nav>}
          <p className="consentNote">Uses one device slot when your app finishes connecting.</p>
        </>}
        {message && <p role="alert" className="consentMessage">{message}</p>}
        {mutation && phase==="ready" && <p className="muted">Your original selection is saved for this retry.</p>}
        {phase==="expired" && <p>Return to your app and start connecting again.</p>}
        {phase==="cancelled" && <p>This request cannot activate a device.</p>}
        {phase==="connected" && <p>You can close this page and continue in your app.</p>}
        {phase==="approved" && callback && <><p>Return to your app to finish. If nothing happens, try again below.</p><a className="button" href={callback}>Open app</a></>}
        {terminal?<button onClick={onDone}>Go to portal</button>:phase==="ready"?<div className="actions consentActions">
          {!details?<button disabled={busy||waiting} onClick={()=>void runOnce(inspect)}>Retry</button>:mutation?<button className="primary" disabled={busy||waiting} onClick={()=>void act(mutation.operation)}>{busy?"Checking…":mutation.operation==="approve"?"Retry approval":"Retry cancellation"}</button>:<>
            <button disabled={busy||waiting} onClick={()=>void act("deny")}>Cancel</button><button className="primary" disabled={busy||waiting||!selected||!comparisonConfirmed} onClick={()=>void act("approve")}>{busy?"Connecting…":"Approve"}</button>
          </>}
        </div>:null}
      </>}
    </section>
    {customerId && <div className="consentAccount"><details><summary>Account details</summary><p>{customerId}</p></details><button className="consentSignOut" disabled={busy} onClick={()=>void runOnce(onSignOut)}>Sign out</button><p>To use another account, sign out and restart Connect in your app.</p></div>}
  </main>;
}
