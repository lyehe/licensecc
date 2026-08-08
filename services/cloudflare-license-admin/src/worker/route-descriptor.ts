import type { AdminRouteMethod } from "./routes.js";
import type { AdminRequestContext } from "./context.js";
import { invokeOperation } from "./operations.js";

export type RouteGroup =
  | "meta"
  | "summary-reports"
  | "customers"
  | "catalog"
  | "policies"
  | "entitlements"
  | "devices"
  | "webhooks"
  | "sync";

export type RouteAuthorization = "public" | "reader" | "admin" | "sync";

export interface RouteDescriptor {
  readonly method: AdminRouteMethod;
  readonly path: string;
  readonly group: RouteGroup;
  readonly authorization: RouteAuthorization;
  readonly paramNames: readonly string[];
  readonly handle: (context: AdminRequestContext) => Promise<Response>;
}

export function operationDescriptor(
  group: RouteGroup,
  authorization: Exclude<RouteAuthorization, "public">,
  method: AdminRouteMethod,
  path: string,
  paramNames: readonly string[] = [],
): RouteDescriptor {
  const key = `${method} ${path}`;
  return {
    group,
    authorization,
    method,
    path,
    paramNames,
    async handle(context) {
      if (context.actor === null) {
        throw new Error(`authenticated route reached without actor: ${key}`);
      }
      return invokeOperation(
        key,
        context.request,
        context.env,
        paramNames.map((name) => context.params[name] ?? ""),
        context.requestId,
        context.actor,
      );
    },
  };
}
