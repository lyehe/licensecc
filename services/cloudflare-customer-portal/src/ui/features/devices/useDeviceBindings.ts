import { useCallback, useEffect, useRef, useState } from "react";
import type { BindingRow } from "../../../shared/bindings";
import { readBindings } from "./bindingApi";

type View = {context:string;rows:BindingRow[];cursor:string|null;loading:boolean;ready:boolean;stale:boolean;signInNeeded:boolean;error:string};
const empty=(context:string):View=>({context,rows:[],cursor:null,loading:true,ready:false,stale:false,signInNeeded:false,error:""});
/** Search traverses sparse candidate pages with a fixed per-interaction budget, never a fetch-all. */
export function useDeviceBindings(customer:string,query:string,project:string|null) {
  const context=JSON.stringify([customer,query.trim(),project]);
  const [state,setState]=useState(()=>empty(context));
  const latest=useRef(state);latest.current=state;
  const generation=useRef({context,id:0});
  if(generation.current.context!==context)generation.current={context,id:generation.current.id+1};
  const live=useRef(true),requestId=useRef(0);
  useEffect(()=>{live.current=true;return()=>{live.current=false;requestId.current++;};},[]);
  const load=useCallback(async(next=""):Promise<boolean>=>{
    if(context!==generation.current.context)return false;
    const id=++requestId.current,epoch=generation.current.id;
    const current=():boolean=>live.current && requestId.current===id && generation.current.id===epoch;
    const base=next && latest.current.context===context?latest.current.rows:[];
    setState(previous=>({...previous,context,rows:next?base:previous.context===context?previous.rows:[],loading:true,error:""}));
    const rows=[...base],seen=new Set(rows.map(row=>row.binding_id));
    let cursor=next,more=false;
    try {
      for(let page=0;page<5;page++){
        const result=await readBindings(customer,cursor,query,project);
        if(!current())return false;
        if(!result.ok){
          setState(previous=>({...previous,loading:false,stale:true,signInNeeded:["account_changed","unauthorized"].includes(result.code),error:result.code==="account_changed"?"Your signed-in account changed. Sign in again before managing devices.":"Could not refresh connected devices. Try again."}));return false;
        }
        for(const row of result.data.items){
          if(seen.has(row.binding_id))throw new Error("Device results changed. Refresh before disconnecting.");
          seen.add(row.binding_id);rows.push(row);
        }
        more=result.data.has_more;cursor=result.data.next_cursor??"";
        if(!query.trim() || !more || rows.length-base.length>=100)break;
      }
      if(current())setState({context,rows,cursor:more?cursor:null,loading:false,ready:true,stale:false,signInNeeded:false,error:""});
      return current();
    }catch(error){
      if(current())setState(previous=>({...previous,loading:false,stale:true,error:error instanceof Error?error.message:"Could not refresh connected devices. Try again."}));
      return false;
    }
  },[context,customer,query,project]);
  useEffect(()=>{
    setState(empty(context));
    const timer=setTimeout(()=>void load(),query.trim()?300:0);
    return()=>clearTimeout(timer);
  },[context,load,query]);
  const view=state.context===context?state:empty(context);
  return {...view,load,invalidate:()=>setState(previous=>({...previous,stale:true}))};
}
