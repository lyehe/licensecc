import { useRef, type Dispatch, type FormEvent, type SetStateAction } from "react";
import type { EntitlementRecord } from "../../../shared/api";
import { api } from "../../shared/api";
import { useOperatorControls } from "../../shared/controls";
import { hasEntitlementRecordData, mutationFailurePolicies, parseMutationResponse } from "../../shared/mutationGuards";
import { codeFeedback, failureFeedback, feedbackWith, validationCode } from "../../shared/messages";
import { protectedCreateFailureMessage } from "./protectedCreate";
import { useCreateLicense } from "./CreateLicense";
import { normalizeCreateFromPolicy, normalizeEntitlementForm, type EntitlementFormState } from "./workflow";
import type { GrantChoice } from "./GuidedGrantFields";
import type { ExactReadProof } from "../../shared/controls";

export function useEntitlementCreate({form, guided, choice, policyAvailable, isListCurrent, setForm, onApplied, refresh}: {
  form: EntitlementFormState; guided: boolean; choice: GrantChoice; policyAvailable: boolean;
  isListCurrent(): boolean; setForm: Dispatch<SetStateAction<EntitlementFormState>>;
  onApplied(item: EntitlementRecord): void; refresh(): Promise<ExactReadProof | null>;
}): (event: FormEvent) => Promise<void> {
  const {runKeyedMutation,setFeedback,setMessage} = useOperatorControls();
  const createLicense=useCreateLicense();
  const latest=useRef(form);latest.current=form;
  const submitting=useRef(false);
  return async event=>{
    event.preventDefault();
    if(submitting.current)return;
    if(form.policy_id && !policyAvailable){setFeedback(codeFeedback("policy_not_available"));return;}
    if(guided && (!choice.ready || choice.context!==`${form.customer_id}\0${form.project}` || (!choice.createNew && !form.license_id))){setMessage("Choose a current license or create a new one before saving.");return;}
    const snapshot=(draft:EntitlementFormState):string=>JSON.stringify(guided?{...draft,license_id:""}:draft);
    const captured=snapshot(form), isCurrent=():boolean=>isListCurrent() && snapshot(latest.current)===captured;
    submitting.current=true;
    try {
      let draft=form;
      if(guided && !draft.license_id){
        const id=await createLicense(draft.customer_id,draft.project,id=>{
          if(!isCurrent())return;
          setForm(previous=>({...previous,license_id:id}));
          setMessage("License record created. Access not granted until the entitlement is saved. Save again if a retry is needed.");
        },isCurrent);
        if(!id || !isCurrent())return;
        draft={...draft,license_id:id};
      }
      let body:ReturnType<typeof normalizeEntitlementForm>|ReturnType<typeof normalizeCreateFromPolicy>;
      try {body=draft.policy_id?normalizeCreateFromPolicy(draft):normalizeEntitlementForm(draft);}
      catch(error){setFeedback(codeFeedback(validationCode(error)));return;}
      const expectedStatus=body.status??"active",expectedLimit="max_active_devices" in body?body.max_active_devices:undefined;
      await runKeyedMutation({
        request:{method:"POST",path:"/api/admin/entitlements",body:JSON.stringify(body)},
        send:attempt=>api<EntitlementRecord>(attempt.path,{method:attempt.method,headers:{"idempotency-key":attempt.idempotencyKey},body:attempt.body}),
        parse:(result,phase)=>parseMutationResponse(result,"entitlement_saved",(value):value is EntitlementRecord=>{
          if(!hasEntitlementRecordData(value))return false;
          const row=value as EntitlementRecord;
          return row.project===body.project && row.feature===body.feature && row.license_fingerprint===body.license_fingerprint
            && row.customer_id===body.customer_id && row.license_id===(body.license_id??null) && row.status===expectedStatus && (expectedLimit===undefined || row.max_active_devices===expectedLimit);
        },mutationFailurePolicies.entitlementCreate,phase),
        onApplied:parsed=>{if(isCurrent()){setFeedback(codeFeedback(parsed.code,parsed.requestId));onApplied(parsed.data);}},
        refresh,
        onUnapplied:parsed=>{
          if(!isCurrent())return;
          const refusal=protectedCreateFailureMessage(parsed);
          const feedback=refusal===null?failureFeedback(parsed.code,parsed.requestId):feedbackWith(refusal,parsed.code,parsed.requestId);
          setFeedback(guided?{...feedback,message:`Access not granted. ${feedback.message}`}:feedback);
        },
        isCurrent,
      });
    }finally{submitting.current=false;}
  };
}
