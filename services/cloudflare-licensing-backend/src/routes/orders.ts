import type { Env } from "../env.js";
import { handleOrderIngest } from "../fulfillment/order_ingest.mjs";

// Route-level adapter: fulfillment owns the signed exactly-once order workflow.
export function handleOrders(request: Request, env: Env): Promise<Response> {
  return handleOrderIngest(request, env);
}
