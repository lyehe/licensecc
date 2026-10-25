import { useEffect, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import type { EntitlementRecord } from "../../../shared/api";
import { api, parseExactApiSuccess } from "../../shared/api";
import { EXACT_READ_PROOF, useOperatorControls } from "../../shared/controls";
import { hasEntitlementRecordData, mutationFailurePolicies, parseMutationResponse } from "../../shared/mutationGuards";
import { codeFeedback, failureFeedback, feedbackWith, validationCode } from "../../shared/messages";
import { protectedCreateFailureMessage } from "./protectedCreate";
import { useCreateLicense } from "./CreateLicense";
import { normalizeCreateFromPolicy, normalizeEntitlementForm, type EntitlementFormState } from "./workflow";
import type { GrantChoice } from "./GuidedGrantFields";
import type { ExactReadProof } from "../../shared/controls";

type PartialLicense = { id: string; customer: string; project: string; fingerprint: string };
export function useEntitlementCreate({form, guided, choice, policyAvailable, isListCurrent, setForm, onApplied, refresh}: {
  form: EntitlementFormState; guided: boolean; choice: GrantChoice; policyAvailable: boolean;
  isListCurrent(): boolean; setForm: Dispatch<SetStateAction<EntitlementFormState>>;
  onApplied(item: EntitlementRecord): void; refresh(): Promise<ExactReadProof | null>;
}): { submitCreate(event: FormEvent): Promise<void>; partialLicenseId: string | null } {
  const {runKeyedMutation,setFeedback,setMessage} = useOperatorControls();
  const createLicense=useCreateLicense();
  const latest=useRef(form);latest.current=form;
  const submitting=useRef(false);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const [partialLicense,setPartialLicense]=useState<PartialLicense|null>(null);
  const partial=partialLicense && partialLicense.id===form.license_id && partialLicense.customer===form.customer_id
    && partialLicense.project===form.project && partialLicense.fingerprint===form.license_fingerprint?partialLicense:null;
  async function submitCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if(submitting.current)return;
    if(form.policy_id && !policyAvailable){setFeedback(codeFeedback("policy_not_available"));return;}
    if(guided && (!choice.ready || choice.context!==`${form.customer_id}\0${form.project}` || (!choice.createNew && !form.license_id))){setMessage("Choose a current license or create a new one before saving.");return;}
    const snapshot=(draft:EntitlementFormState):string=>JSON.stringify(guided?{...draft,license_id:""}:draft);
    const captured=snapshot(form), isReadCurrent=():boolean=>mounted.current && isListCurrent();
    const isCurrent=():boolean=>isReadCurrent() && snapshot(latest.current)===captured;
    submitting.current=true;
    try {
      let draft=form;
      let createdLicense=partial;
      if(guided && !draft.license_id){
        const id=await createLicense(draft.customer_id,draft.project,id=>{
          if(!isCurrent())return;
          setForm(previous=>({...previous,license_id:id}));
          createdLicense={id,customer:draft.customer_id,project:draft.project,fingerprint:draft.license_fingerprint};
          setPartialLicense(createdLicense);
        },isCurrent);
        if(!id || !isCurrent())return;
        draft={...draft,license_id:id};
      }
      let body:ReturnType<typeof normalizeEntitlementForm>|ReturnType<typeof normalizeCreateFromPolicy>;
      try {body=draft.policy_id?normalizeCreateFromPolicy(draft):normalizeEntitlementForm(draft);}
      catch(error){setFeedback(codeFeedback(validationCode(error)));return;}
      const expectedStatus=body.status??"active",expectedLimit="max_active_devices" in body?body.max_active_devices:undefined;
      let saved: {data: EntitlementRecord;code:string;requestId:string}|null=null;
      let completed=false;
      // Once an entitlement is sent its outcome may be unknown. Only a conclusive refusal can
      // restore the license-only message; a known write waits for GET-only confirmation below.
      setPartialLicense(null);
      await runKeyedMutation({
        request:{method:"POST",path:"/api/admin/entitlements",body:JSON.stringify(body)},
        send:attempt=>api<EntitlementRecord>(attempt.path,{method:attempt.method,headers:{"idempotency-key":attempt.idempotencyKey},body:attempt.body}),
        parse:(result,phase)=>parseMutationResponse(result,"entitlement_saved",(value):value is EntitlementRecord=>{
          if(!hasEntitlementRecordData(value))return false;
          const row=value as EntitlementRecord;
          return row.project===body.project && row.feature===body.feature && row.license_fingerprint===body.license_fingerprint
            && row.customer_id===body.customer_id && row.license_id===(body.license_id??null) && row.status===expectedStatus && (expectedLimit===undefined || row.max_active_devices===expectedLimit);
        },mutationFailurePolicies.entitlementCreate,phase),
        onApplied:parsed=>{
          saved=parsed;
          // The advanced list keeps its existing filter/navigation behavior after a known write.
          // Guided creation stays on its draft until the exact read below confirms the grant.
          if(!guided && isCurrent()){
            completed=true;setFeedback(codeFeedback(parsed.code,parsed.requestId));onApplied(parsed.data);
          }
        },
        refresh:async()=>{
          if(!saved || !mounted.current)return null;
          const target=saved.data;
          const response=await api(`/api/admin/entitlements/${encodeURIComponent(target.id)}`);
          const exact=parseExactApiSuccess<EntitlementRecord>(response,"entitlement",value=>{
            if(!hasEntitlementRecordData(value))return false;
            const row=value as EntitlementRecord;
            return row.id===target.id && row.project===target.project && row.feature===target.feature
              && row.license_fingerprint===target.license_fingerprint && row.customer_id===target.customer_id
              && row.license_id===target.license_id && row.status===target.status;
          });
          if(!exact || !mounted.current || await refresh()!==EXACT_READ_PROOF || !mounted.current)return null;
          if(!completed && isCurrent()){
            completed=true;
            setFeedback(codeFeedback(saved.code,saved.requestId));onApplied(exact.data);
          }
          return EXACT_READ_PROOF;
        },
        onUnapplied:parsed=>{
          if(!isCurrent())return;
          setPartialLicense(createdLicense);
          const refusal=protectedCreateFailureMessage(parsed);
          const feedback=refusal===null?failureFeedback(parsed.code,parsed.requestId):feedbackWith(refusal,parsed.code,parsed.requestId);
          setFeedback(guided?{...feedback,message:`Access not granted. ${feedback.message}`}:feedback);
        },
        isCurrent,
      });
    }finally{submitting.current=false;}
  }
  return {submitCreate,partialLicenseId:partial?.id??null};
}
