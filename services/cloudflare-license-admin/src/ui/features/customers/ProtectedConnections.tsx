import React,{useEffect,useRef,useState} from 'react';
import { useOperatorControls } from '../../shared/controls';
import { formatEpoch } from '../../shared/format';
import { clearPending,createPending,operatorKey,readConnections,readHistory,restorePending,retireConnection,savePending,type BindingEvent,type Connection,type Context,type Page,type Pending } from './connectionWorkflow';
const contextIdentity=(value:Context)=>JSON.stringify([value.customer.id,value.customer.status,value.operator.actor_type,value.operator.subject,value.operator.role]);
function retainDialogFocus(event:React.KeyboardEvent<HTMLDialogElement>):void {
  if(event.key!=='Tab')return;
  const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
  const first=buttons[0],last=buttons.at(-1);
  if(!first){event.preventDefault();event.currentTarget.focus();}
  else if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
  else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
}

function ConnectionHistory({customer,binding,expected,onContextChanged}:{customer:string;binding:string;expected:string;onContextChanged():void}):React.ReactElement {
  const [rows,setRows]=useState<BindingEvent[]>([]),[cursor,setCursor]=useState<string|null>(null),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const live=useRef(true),reading=useRef(false),identity=useRef('');
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  async function load(next=''):Promise<void>{
    if(reading.current)return;reading.current=true;setBusy(true);setError('');
    try{const result=await readHistory(customer,binding,next);if(!live.current)return;
      if(!result.ok){setError('History could not be refreshed. Displayed events may be out of date.');return;}
      if(contextIdentity(result.data)!==expected || (next && contextIdentity(result.data)!==identity.current)){setError('Operator or customer access changed. Refresh connections and history.');onContextChanged();return;}
      identity.current=contextIdentity(result.data);setRows(old=>next?[...old,...result.data.items]:result.data.items);setCursor(result.data.next_cursor);setLoaded(true);
    }finally{reading.current=false;if(live.current)setBusy(false);}
  }
  return <details onToggle={event=>{if(event.currentTarget.open && !loaded)void load();}}><summary>History</summary>
    {error && <p role="alert">{error}</p>}{identity.current && expected!==identity.current && <p>History is from an earlier access context. Refresh it to continue.</p>}{busy && <p role="status">Loading history…</p>}
    {loaded && !rows.length && <p>No events recorded.</p>}
    <ol className="connectionHistory">{rows.map(row=><li key={row.id}><strong>{row.event_type==='retire'?'Retired':row.event_type==='exchange'?'Connected':'Renewed'}</strong> · {formatEpoch(row.occurred_at)}<span>{row.actor}</span></li>)}</ol>
    <div className="actions"><button disabled={busy} onClick={()=>void load()}>Refresh history</button>{cursor && <button disabled={busy || !!error || identity.current!==expected} onClick={()=>void load(cursor)}>More events</button>}</div>
  </details>;
}

export function ProtectedConnections({customer,active=true}:{customer:string;active?:boolean}):React.ReactElement|null {
  const controls=useOperatorControls();
  const [page,setPage]=useState<Page|null>(null),[loading,setLoading]=useState(false),[stale,setStale]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [saved,setSaved]=useState(()=>restorePending(customer)),[draft,setDraft]=useState<Pending|null>(null),[open,setOpen]=useState(false),[sending,setSending]=useState(false);
  const [stopped,setStopped]=useState(false),[reviewed,setReviewed]=useState<Connection|null|undefined>(undefined),[reviewReady,setReviewReady]=useState(false);
  const [dialogError,setDialogError]=useState('');
  const [confirmed,setConfirmed]=useState(false);
  const live=useRef(true),reading=useRef(false),sendingRef=useRef(false),dialog=useRef<HTMLDialogElement>(null),heading=useRef<HTMLHeadingElement>(null),cancel=useRef<HTMLButtonElement>(null);
  const pending=saved && saved!=='invalid'?saved:draft;
  const pendingRef=useRef(pending);pendingRef.current=pending;
  const reviewGeneration=useRef(0);
  const locked=controls.busy || controls.operationLocked || controls.modalActive || sending;
  useEffect(()=>{live.current=true;void load();return()=>{live.current=false;};},[]);
  useEffect(()=>{if(!active && !saved){reviewGeneration.current++;setOpen(false);setDraft(null);}},[active,saved]);
  useEffect(()=>{if(open && !dialog.current?.open){dialog.current?.showModal();cancel.current?.focus();}else if(!open && dialog.current?.open){dialog.current.close();heading.current?.focus();}},[open,active,saved]);
  async function load(cursor=''):Promise<boolean>{
    if(reading.current)return false;reading.current=true;setLoading(true);setError('');
    try{const result=await readConnections(customer,cursor);if(!live.current)return false;
      if(!result.ok || (cursor && page && (operatorKey(result.data.operator)!==operatorKey(page.operator) || result.data.operator.role!==page.operator.role || result.data.customer.status!==page.customer.status))){
        setStale(true);setError('Connections could not be refreshed. Check your sign-in and refresh before making changes.');return false;
      }
      setPage(old=>cursor && old?{...result.data,items:[...old.items,...result.data.items]}:result.data);setStale(false);return true;
    }finally{reading.current=false;if(live.current)setLoading(false);}
  }
  function start(row:Connection):void{
    if(locked || loading || stale || saved || !page || page.operator.role!=='admin' || page.customer.status!=='active')return;
    reviewGeneration.current++;setDraft(createPending(customer,row,page.operator));setDialogError('');setStopped(false);setConfirmed(false);setReviewReady(false);setReviewed(undefined);setOpen(true);
  }
  function resume():void{if(locked)return;reviewGeneration.current++;setDraft(null);setDialogError('');setReviewReady(false);setReviewed(undefined);setOpen(true);}
  function close():void{if(sendingRef.current)return;reviewGeneration.current++;setOpen(false);setDraft(null);}
  async function send():Promise<void>{
    if(!pending || locked || sendingRef.current || reading.current || stopped || !page || stale || page.operator.role!=='admin' || page.customer.status!=='active' || operatorKey(page.operator)!==operatorKey(pending.operator))return;
    const intent=pending;
    await controls.runMutation(async()=>{
      sendingRef.current=true;setSending(true);setDialogError('');
      try{
        if(!savePending(intent)){setDialogError('Browser storage is unavailable. No request was sent. Enable session storage before retrying.');return;}
        setSaved(intent);
        const result=await retireConnection(intent);if(!live.current)return;
        if(!result.ok){setStopped(result.code!=='temporarily_unavailable');setDialogError(confirmed?'Retirement was already confirmed. This retry did not complete; the saved request is retained for local cleanup.':result.code==='temporarily_unavailable'
          ?'The result is not confirmed. Retry the same request to recover its outcome.'
          :'This request cannot continue. Review the current connection before clearing the saved request.');return;}
        setConfirmed(true);
        if(!clearPending(customer)){setDialogError('Retirement was confirmed, but the saved request could not be cleared. Retry to recover the same result.');return;}
        setSaved(null);setDraft(null);setOpen(false);setStale(true);
        setMessage(`Renewal stopped for ${intent.label}. Its slot becomes available ${formatEpoch(result.data.effective_release_at)}. Connect the replacement machine from its app after that time.`);
        await load();if(live.current)heading.current?.focus();
      }finally{sendingRef.current=false;if(live.current)setSending(false);}
    });
  }
  async function review():Promise<void>{
    if(sendingRef.current || reading.current || !allowReview)return;const intent=pending,generation=++reviewGeneration.current;setReviewReady(false);setDialogError('');
    if(!intent){if(await load() && generation===reviewGeneration.current)setReviewReady(true);return;}
    reading.current=true;setLoading(true);
    try{const result=await readConnections(customer,'',intent.binding);if(!live.current || generation!==reviewGeneration.current || pendingRef.current?.key!==intent.key || pendingRef.current?.binding!==intent.binding || pendingRef.current?.revision!==intent.revision)return;
      if(!result.ok){setDialogError('Current connection could not be checked. Keep the saved request and retry the review.');return;}
      setReviewed(result.data.items[0]??null);setReviewReady(true);
    }finally{reading.current=false;if(live.current)setLoading(false);}
  }
  function clearReviewed():void{
    if(!allowReview || !reviewReady || sendingRef.current || reading.current)return;
    if(!clearPending(customer)){setDialogError('The saved request could not be cleared. Check browser storage and try again.');return;}
    setSaved(null);setDraft(null);setStopped(false);setOpen(false);setReviewReady(false);setStale(true);void load();
  }
  const mayRetire=page?.operator.role==='admin' && page.customer.status==='active';
  const sameOperator=!!pending && !!page && operatorKey(page.operator)===operatorKey(pending.operator);
  const allowReview=!!saved && (saved==='invalid' || stopped || confirmed || (!!page && !stale && (!sameOperator || !mayRetire)));
  if(!active && !saved)return null;
  return <section className="protectedConnections" aria-label="Protected connections" aria-busy={loading}>
    <div className="sectionHeading"><div><h3 ref={heading} tabIndex={-1}>Protected connections</h3><p>Machines holding an app license slot. Last verified contact is not live presence.</p></div><button disabled={loading || sending} onClick={()=>void load()}>Refresh connections</button></div>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    {saved && <div className="connectionNotice" role="status"><p>{saved==='invalid'?'A saved retirement request cannot be read. Review this customer before clearing it.':`A retirement request for ${saved.label} needs resolution.`}</p><button disabled={locked} onClick={resume}>Review saved request</button></div>}
    {loading && <p role="status">Loading connections…</p>}
    {page && !page.items.length && !stale && <p>No protected connections yet. Customers connect a machine from their app.</p>}
    {page?.customer.status==='disabled' && <p>Customer disabled. Connections remain visible; retirement requires an active customer.</p>}
    <div className="customerAccessRecords">{page?.items.map(row=><article className="recordCard protectedConnection" key={row.binding_id}>
      <h4>{row.label||'Unnamed connection'}</h4><p>{row.project} · {row.feature}</p>
      <p><strong>{row.state==='active'?'Connected':row.state==='retiring'?'Retiring':'Released'}</strong>{row.state==='retiring' && <> · Slot available {formatEpoch(row.hold_until)}</>}</p>
      <p>Last verified {formatEpoch(row.last_proof_at)}</p>
      <details><summary>Connection details</summary><p>Binding: {row.binding_id}</p><p>License: {row.license_fingerprint}</p></details>
      <ConnectionHistory customer={customer} binding={row.binding_id} expected={contextIdentity(page)} onContextChanged={()=>{setStale(true);setError('Operator or customer access changed. Refresh connections before making changes.');}} />
      {row.state==='active' && mayRetire && <button disabled={locked || loading || stale || !!saved} onClick={()=>start(row)}>Retire connection</button>}
    </article>)}</div>
    {page?.next_cursor && <button disabled={loading || stale || sending} onClick={()=>void load(page.next_cursor!)}>Load more connections</button>}
    <dialog ref={dialog} tabIndex={-1} className="connectionDialog" aria-labelledby="connection-dialog-title" onKeyDown={retainDialogFocus} onCancel={event=>{event.preventDefault();close();}}>
      <h2 id="connection-dialog-title">{saved?'Resolve retirement request':'Retire connection?'}</h2>
      {pending && <><p><strong>{pending.label}</strong> · {pending.project} / {pending.feature}</p><p>Customer: {customer}</p><p>Connection: {pending.binding}</p>
        <p>Renewal stops immediately. Existing signed offline access can continue until its deadline. The slot remains reserved until at least {formatEpoch(pending.hold)}.</p>
        <p>This connection cannot be re-enabled. To transfer, retire it, wait for the slot to become available, then connect the new machine from its app.</p></>}
      {saved && <p>The original request is saved in this browser tab. Closing this dialog does not cancel it.</p>}
      {confirmed && <p role="status">Retirement has been confirmed. The saved request still needs local cleanup.</p>}
      {pending && page && (!sameOperator || !mayRetire) && <p role="alert">Your operator or customer access has changed. Review the connection before clearing this saved request.</p>}
      {dialogError && <p role="alert">{dialogError}</p>}
      {reviewReady && <p role="status">{pending ? reviewed ? `Current connection: ${reviewed.state}. Reserved until ${formatEpoch(reviewed.hold_until)}.`:'This binding is unavailable in the current customer context.':'Current customer connections have been refreshed.'} Clearing the saved request does not cancel or undo a retirement.</p>}
      <div className="actions">
        {pending && !reviewReady && <button className="primary" disabled={locked || loading || stale || stopped || !mayRetire || !sameOperator} onClick={()=>void send()}>{sending?'Checking…':saved?'Retry same request':'Retire connection'}</button>}
        {allowReview && <button disabled={sending || loading} onClick={()=>void review()}>Review current connection</button>}
        {allowReview && reviewReady && <button disabled={sending || loading} onClick={clearReviewed}>Clear reviewed request</button>}
        <button ref={cancel} disabled={sending} onClick={close}>{saved?'Close':'Cancel'}</button>
      </div>
    </dialog>
  </section>;
}
