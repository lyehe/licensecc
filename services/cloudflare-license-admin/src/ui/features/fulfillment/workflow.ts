import { feedbackWith } from "../../shared/messages";
import type { OperatorFeedback } from "../../shared/operatorFeedback";

export interface OrderListFilter {
  status: string;
  subscription_id: string;
}

export function ordersPath(filter: OrderListFilter): string {
  const params = new URLSearchParams();
  if (filter.status !== "") params.set("status", filter.status);
  if (filter.subscription_id !== "") params.set("subscription_id", filter.subscription_id);
  return `/api/admin/orders${params.size === 0 ? "" : `?${params.toString()}`}`;
}

/*
 * Why the licensing backend refused an order, for each code it records on a rejected order. These
 * describe the store's order, not an action in this console, so they are kept apart from the
 * console's own result copy (capacity_in_use there answers a device-limit change made here).
 */
const ORDER_REFUSAL_TEXT: Readonly<Record<string, string>> = {
  customer_email_conflict: "The order's email already belongs to another customer.",
  entitlement_revoked: "The order's license (entitlement) is revoked, and revocation is permanent.",
  entitlement_owner_mismatch: "The order's license (entitlement) belongs to another customer.",
  invalid_order: "The order's customer or license contradicts the records it names.",
};

const ORDER_REFUSED_TEXT = "The order was refused.";

/** The sentence for a refused order, with its stored code kept under Technical details. */
export function orderRefusalFeedback(code: string | null): OperatorFeedback {
  if (code === null) return { tone: "error", message: ORDER_REFUSED_TEXT };
  return feedbackWith(Object.hasOwn(ORDER_REFUSAL_TEXT, code) ? ORDER_REFUSAL_TEXT[code] : ORDER_REFUSED_TEXT, code);
}
