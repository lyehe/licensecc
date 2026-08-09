import { requestId } from "@licensecc/cloudflare-runtime/http/kit";
import { authenticate, authenticateSync, requireAdmin } from "./auth.js";
import type { AdminRequestContext } from "./context.js";
import { matchRoute, rejectsCrossSiteMutation } from "./dispatch.js";
import type { Env } from "./env.js";
import { envelope } from "./response.js";

// The composition root owns matching, authentication, dispatch, and the historical asset
// fallback only. Bounded-context modules own their route descriptors and operation calls.
export const adminApp = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const match = matchRoute(request.method, pathname);

    if (match === null) {
      if (pathname.startsWith("/api/admin/")) {
        const id = requestId(request);
        const actor = await authenticate(request, env, id);
        return actor instanceof Response ? actor : envelope(id, "not_found", undefined, 404);
      }
      if (pathname.startsWith("/api/sync/")) {
        const id = requestId(request);
        const actor = await authenticateSync(request, env, id);
        return actor instanceof Response ? actor : envelope(id, "not_found", undefined, 404);
      }
      return env.ASSETS === undefined ? new Response("not found", { status: 404 }) : env.ASSETS.fetch(request);
    }

    const id = requestId(request);
    if (rejectsCrossSiteMutation(request)) return envelope(id, "cross_site_mutation_forbidden", undefined, 403);
    let actor = null;
    if (match.descriptor.authorization === "reader" || match.descriptor.authorization === "admin") {
      const authenticated = await authenticate(request, env, id);
      if (authenticated instanceof Response) return authenticated;
      if (match.descriptor.authorization === "admin") {
        const adminError = requireAdmin(authenticated, id);
        if (adminError !== null) return adminError;
      }
      actor = authenticated;
    } else if (match.descriptor.authorization === "sync") {
      const authenticated = await authenticateSync(request, env, id);
      if (authenticated instanceof Response) return authenticated;
      actor = authenticated;
    }

    const context: AdminRequestContext = {
      request,
      env,
      requestId: id,
      actor,
      params: match.params,
    };
    return match.descriptor.handle(context);
  },
};
