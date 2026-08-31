import { docsHtml } from "../docs_page.js";
import { openApiJson } from "../openapi/document.js";
import type { RouteDescriptor } from "../route-descriptor.js";
import { secureHtml } from "@licensecc/cloudflare-runtime/http/kit";

export const metaRoutes: readonly RouteDescriptor[] = [
  {
    method: "GET",
    path: "/openapi.json",
    group: "meta",
    authorization: "public",
    paramNames: [],
    async handle() {
      return new Response(openApiJson, { headers: { "content-type": "application/json; charset=utf-8" } });
    },
  },
  {
    method: "GET",
    path: "/docs",
    group: "meta",
    authorization: "public",
    paramNames: [],
    async handle() {
      return secureHtml(docsHtml);
    },
  },
];
