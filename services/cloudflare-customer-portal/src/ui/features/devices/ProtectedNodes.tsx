import React,{useEffect,useRef,useState} from "react";
import type { BindingRow } from "../../../shared/bindings";
import { readBinding,readBindings,retireBinding } from "./bindingApi";
import { clearRetirement,restoreRetirement,saveRetirement,type PendingRetirement } from "./pendingRetirement";
import { formatTimestamp } from "../../portalWorkflow";

type Props={customer:string;busy:boolean;runOnce(work:()=>Promise<void>):Promise<void>;onSessionExpired():Promise<boolean>};
export function ProtectedNodes({customer,busy,runOnce,onSessionExpired}:Props):React.ReactElement {
  const [rows,setRows]=useState<BindingRow[]>([]),[cursor,setCursor]=useState<string|null>(null),[loading,setLoading]=useState(false),[ready,setReady]=useState(false),[stale,setStale]=useState(false);
  const [saved,setSaved]=useState(()=>restoreRetirement(customer));
  const [pending,setPending]=useState<PendingRetirement|null>(saved && saved!=="invalid"?saved:null);
  const pendingRef=useRef(pending);pendingRef.current=pending;
  const [open,setOpen]=useState(false),[message,setMessage]=useState(""),[error,setError]=useState(""),[terminal,setTerminal]=useState(false);
  const [signInNeeded,setSignInNeeded]=useState(false),[reviewed,setReviewed]=useState<BindingRow|null|undefined>(undefined),[unreadableReviewed,setUnreadableReviewed]=useState(false);
  const [retryAt,setRetryAt]=useState(0),[clock,setClock]=useState(Date.now());
  const live=useRef(true),reading=useRef(false),sending=useRef(false),dialog=useRef<HTMLDialogElement>(null),heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{live.current=true;void load();return()=>{live.current=false;};},[]);
  useEffect(()=>{if(open && !dialog.current?.open)dialog.current?.showModal();else if(!open && dialog.current?.open){dialog.current.close();heading.current?.focus();}},[open]);
  useEffect(()=>{if(!retryAt)return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[retryAt]);

  async function load(next=""):Promise<boolean> {
    if(reading.current)return false;reading.current=true;setLoading(true);
    try {
      const result=await readBindings(customer,next);if(!live.current)return false;
      if(!result.ok){setStale(true);setSignInNeeded(["account_changed","unauthorized"].includes(result.code));setMessage(result.code==="account_changed"?"Your signed-in account changed. Sign in again before managing devices.":"Could not refresh connected devices. Try again.");return false;}
      setSignInNeeded(false);
      setRows(current=>next?[...current,...result.data.items]:result.data.items);setCursor(result.data.next_cursor);setReady(true);setStale(false);return true;
    }finally{reading.current=false;if(live.current)setLoading(false);}
  }
  function choose(row:BindingRow):void {
    if(busy || stale || saved || sending.current)return;
    const key=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    setPending({customer,binding:row.binding_id,revision:row.revision,key,label:row.label||"Unnamed device",project:row.project,feature:row.feature,hold:row.hold_until});
    setError("");setTerminal(false);setReviewed(undefined);setOpen(true);
  }
  function close():void {if(sending.current)return;setOpen(false);if(!saved)setPending(null);heading.current?.focus();}
  async function confirm():Promise<void> {
    if(!pending || sending.current || busy || clock<retryAt || terminal)return;
    const intent=pending;
    await runOnce(async()=>{
      sending.current=true;setError("");
      try {
        if(!saveRetirement(intent)){setError("Browser storage is unavailable. No request was sent. Enable session storage and retry.");return;}
        setSaved(intent);
        const result=await retireBinding(customer,{binding_id:intent.binding,expected_revision:intent.revision},intent.key);
        if(!live.current)return;
        if(!result.ok){
          const stopped=["invalid_request","unauthorized","account_changed","cross_site_forbidden","access_denied","binding_unavailable","revision_conflict","idempotency_conflict"].includes(result.code);
          setTerminal(stopped);
          setError(stopped?"This request cannot continue. Review current devices before starting another action.":"The result is not confirmed. Retry this same request to check the outcome.");
          if(result.retryAfter){setRetryAt(Date.now()+result.retryAfter*1000);setClock(Date.now());}
          return;
        }
        if(!clearRetirement(customer)){setError("Disconnection confirmed, but the saved request could not be cleared. Retry to recover the same result.");return;}
        setSaved(null);setPending(null);setOpen(false);setRetryAt(0);
        setMessage(`Renewal stopped for ${intent.label}. Its slot becomes available ${formatTimestamp(result.data.effective_release_at)}. To transfer, connect the new device from your app after this time.`);
        setStale(true);await load();heading.current?.focus();
      }finally{sending.current=false;}
    });
  }
  async function review():Promise<void> {
    if(busy || sending.current)return;
    const intent=pending;
    await runOnce(async()=>{
      if(!intent){if(await load())setUnreadableReviewed(true);return;}
      const result=await readBinding(customer,intent.binding),current=pendingRef.current;
      if(!live.current || current?.binding!==intent.binding || current.key!==intent.key || current.revision!==intent.revision)return;
      if(!result.ok){setError("Could not inspect this connection. Keep the saved request and check sign-in or retry.");return;}
      setReviewed(result.data.items[0]??null);setError("");
    });
  }
  function discard():void {
    if(busy || sending.current || (reviewed===undefined && !unreadableReviewed))return;
    if(!clearRetirement(customer)){setMessage("Could not clear the saved request. Check browser session storage.");return;}
    setSaved(null);setPending(null);setOpen(false);setError("");setTerminal(false);setReviewed(undefined);setUnreadableReviewed(false);void load();
  }
  return <section className="protectedNodes" aria-busy={loading}>
    <div className="sectionHeading"><div><h2 ref={heading} tabIndex={-1}>Connected devices</h2><p>To add a device, open your app and choose Connect.</p></div><button disabled={busy||loading} onClick={()=>void load()}>Refresh devices</button></div>
    {message && <p role="status" className="readNotice">{message}</p>}
    {signInNeeded && <button disabled={busy} onClick={()=>void onSessionExpired()}>Check sign-in</button>}
    {saved==="invalid"?<div role="alert" className="readNotice"><p>A saved disconnect request cannot be read. Review current devices before clearing it.</p>{unreadableReviewed?<button disabled={busy} onClick={discard}>Clear unreadable request</button>:<button disabled={busy||loading} onClick={()=>void review()}>Review current devices</button>}</div>:saved && <div className="readNotice"><p>A disconnect request for {saved.label} needs confirmation.</p><button disabled={busy} onClick={()=>{setPending(saved);setOpen(true);}}>Review disconnect request</button></div>}
    {stale && <p role="alert">Device information may be out of date. Refresh before disconnecting.</p>}
    {!ready?<p>{loading?"Loading connected devices…":"Connected devices unavailable."}</p>:rows.length===0?<div className="emptyState"><h3>No connected devices</h3><p>Open your application and choose Connect to add this machine.</p></div>:<div className="tablePane full"><table><thead><tr><th>Device</th><th>App</th><th>Status</th><th>Last verified</th><th>Action</th></tr></thead><tbody>
      {rows.map(row=><tr key={row.binding_id}><td data-label="Device"><span>{row.label||"Unnamed device"}<details className="referenceDetails"><summary>Device ID</summary><small className="identifier">{row.binding_id}</small></details></span></td><td data-label="App"><span>{row.project}<small>{row.feature}</small></span></td>
        <td data-label="Status">{row.state==="active"?"Connected":row.state==="released"?"Disconnected":<>Disconnecting · slot available <time>{formatTimestamp(row.hold_until)}</time></>}</td><td data-label="Last verified">{formatTimestamp(row.last_proof_at)}</td>
        <td data-label="Action">{row.state==="active"?<button disabled={busy||loading||stale||!!saved} onClick={()=>choose(row)}>Disconnect</button>:row.state==="released"?"Slot available":"Renewal stopped"}</td></tr>)}
    </tbody></table></div>}
    {cursor && <button disabled={busy||loading||stale} onClick={()=>void load(cursor)}>Load more devices</button>}
    <dialog ref={dialog} className="retirementDialog" aria-labelledby="retirement-title" onCancel={event=>{event.preventDefault();close();}}>
      <h2 id="retirement-title">Disconnect {pending?.label}?</h2>
      <p>{pending?.project} · {pending?.feature}<span className="retirementIdentity">Connection: {pending?.binding}</span></p>
      <p>This device will stop receiving license renewals. It may keep working until its current license expires.</p>
      <p>Slot available: <strong>{formatTimestamp(pending?.hold??0)}</strong>. If this time has passed, the slot is available when disconnection completes. If the connection changes, review its updated release time.</p>
      <p>After the slot is available, connect another device from your app. This connection cannot be restored.</p>
      {error && <p role="alert">{error}</p>}
      {reviewed!==undefined && <p role="status">{reviewed===null?"This connection is no longer available to your account.":`Current connection: ${reviewed.state==="active"?"Connected":reviewed.state==="retiring"?"Disconnecting":"Disconnected"}. Slot available ${formatTimestamp(reviewed.hold_until)}.`} Clear the saved request only after reviewing this status. Clearing does not change the connection.</p>}
      <div className="dialogActions"><button disabled={busy} onClick={close}>{saved?"Close":"Cancel"}</button>{terminal?<>{reviewed!==undefined?<button disabled={busy} onClick={discard}>Clear saved request</button>:<button disabled={busy||loading} onClick={()=>void review()}>Review current devices</button>}<button disabled={busy} onClick={()=>void onSessionExpired()}>Check sign-in</button></>:<button disabled={busy||clock<retryAt} onClick={()=>void confirm()}>{busy?"Confirming…":clock<retryAt?`Retry in ${Math.ceil((retryAt-clock)/1000)}s`:saved?"Retry disconnect":"Disconnect device"}</button>}</div>
    </dialog>
  </section>;
}
