// Environment-free documentation routes.

import { DOCS_HTML } from "../docs_page.js";
import { openApiDocument } from "../openapi/document.js";
import { json } from "../support.js";

export const META_DISPATCH = {
  "GET /openapi.json": () => json(openApiDocument, 200, { "cache-control": "no-store" }),
  "GET /docs": () =>
    new Response(DOCS_HTML, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    }),
};
