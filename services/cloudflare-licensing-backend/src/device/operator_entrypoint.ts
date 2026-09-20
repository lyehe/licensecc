import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env.js";
import { BoundRequestError } from "./bound_request.mjs";
import { retireBoundBindingAsOperator } from "./bound_retire.mjs";

// Bind only the authenticated admin Worker. This capability cannot approve
// enrollment, change ownership, sign a lease or shorten a binding hold.
export class DeviceOperator extends WorkerEntrypoint<Env> {
  async retire(actor:unknown,customerId:string,input:unknown) {
    const request_id=crypto.randomUUID();
    try {
      const db=typeof this.env.DB.withSession==="function"?this.env.DB.withSession("first-primary"):this.env.DB;
      const data=await retireBoundBindingAsOperator(db,actor,customerId,input);
      return {ok:true,status:200,code:"binding_retired",request_id,data};
    }catch(error){
      const known=error instanceof BoundRequestError;
      return {ok:false,status:known?error.status:503,code:known?error.code:"temporarily_unavailable",request_id};
    }
  }
}
