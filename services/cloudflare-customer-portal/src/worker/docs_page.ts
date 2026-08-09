// A self-contained docs page that fetches /openapi.json and renders a grouped, collapsible endpoint
// list. NO external CDN / no network dependency beyond the same-origin /openapi.json fetch.
export const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>licensecc Customer Portal — API</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 0 1rem 4rem; max-width: 960px; margin-inline: auto; }
  h1 { font-size: 1.5rem; margin: 1.5rem 0 .25rem; }
  .sub { color: #777; margin: 0 0 1.5rem; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .05em; color: #888; border-bottom: 1px solid #8884; padding-bottom: .25rem; margin: 2rem 0 .75rem; }
  details { border: 1px solid #8884; border-radius: 6px; margin: .5rem 0; padding: .25rem .75rem; }
  details[open] { background: #8881; }
  summary { cursor: pointer; display: flex; align-items: center; gap: .75rem; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  .method { font-weight: 700; font-size: .75rem; padding: .15rem .5rem; border-radius: 4px; min-width: 3.5rem; text-align: center; color: #fff; }
  .method.get { background: #2563eb; }
  .method.post { background: #16a34a; }
  .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
  .summary-text { color: #666; flex: 1; }
  .desc { margin: .5rem 0; color: #555; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0; font-size: .9rem; }
  th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid #8883; vertical-align: top; }
  th { color: #888; font-weight: 600; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #8882; padding: .1rem .3rem; border-radius: 3px; }
  .sec { font-size: .8rem; color: #888; }
  .err { color: #b91c1c; }
  .err.ok { color: #16a34a; }
  #err { color: #b91c1c; padding: 1rem; }
</style>
</head>
<body>
<h1 id="title">API</h1>
<p class="sub" id="subtitle"></p>
<div id="err" hidden></div>
<div id="groups"></div>
<script>
(async function () {
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === "text") n.textContent = attrs[k]; else if (k === "html") n.innerHTML = attrs[k]; else n.setAttribute(k, attrs[k]); }
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  var spec;
  try {
    var res = await fetch("/openapi.json", { headers: { accept: "application/json" } });
    spec = await res.json();
  } catch (e) {
    var box = document.getElementById("err");
    box.hidden = false;
    box.textContent = "Failed to load /openapi.json: " + e;
    return;
  }
  document.getElementById("title").textContent = (spec.info && spec.info.title) || "API";
  document.getElementById("subtitle").textContent =
    "v" + ((spec.info && spec.info.version) || "?") + " — OpenAPI " + (spec.openapi || "");

  // Group operations by their first tag (fallback "other").
  var groups = {};
  var order = [];
  var paths = spec.paths || {};
  Object.keys(paths).forEach(function (p) {
    var item = paths[p];
    ["get", "post", "put", "patch", "delete"].forEach(function (m) {
      var op = item[m];
      if (!op) return;
      var tag = (op.tags && op.tags[0]) || "other";
      if (!groups[tag]) { groups[tag] = []; order.push(tag); }
      groups[tag].push({ method: m, path: p, op: op });
    });
  });

  var container = document.getElementById("groups");
  order.forEach(function (tag) {
    container.appendChild(el("h2", { text: tag }));
    groups[tag].forEach(function (entry) {
      var op = entry.op;
      var summary = el("summary", null, [
        el("span", { class: "method " + entry.method, text: entry.method.toUpperCase() }),
        el("span", { class: "path", text: entry.path }),
        el("span", { class: "summary-text", text: op.summary || "" }),
      ]);
      var details = el("details", null, [summary]);

      if (op.description) details.appendChild(el("p", { class: "desc", text: op.description }));

      // Security.
      var secNames = (op.security || []).map(function (s) { return Object.keys(s).join("+") || "public"; });
      details.appendChild(el("p", { class: "sec", text: "Security: " + (secNames.length ? secNames.join(" OR ") : "public") }));

      // Parameters.
      if (op.parameters && op.parameters.length) {
        var ptable = el("table", null, [el("tr", null, [el("th", { text: "param" }), el("th", { text: "in" }), el("th", { text: "required" }), el("th", { text: "description" })])]);
        op.parameters.forEach(function (pp) {
          ptable.appendChild(el("tr", null, [
            el("td", null, [el("code", { text: pp.name })]),
            el("td", { text: pp.in || "" }),
            el("td", { text: pp.required ? "yes" : "no" }),
            el("td", { text: pp.description || "" }),
          ]));
        });
        details.appendChild(el("p", { class: "desc", text: "Parameters" }));
        details.appendChild(ptable);
      }

      // Request body content types.
      if (op.requestBody && op.requestBody.content) {
        details.appendChild(el("p", { class: "desc", text: "Request body: " + Object.keys(op.requestBody.content).join(", ") }));
      }

      // Responses.
      var rtable = el("table", null, [el("tr", null, [el("th", { text: "status" }), el("th", { text: "description" })])]);
      var responses = op.responses || {};
      Object.keys(responses).forEach(function (code) {
        var ok = code[0] === "2";
        rtable.appendChild(el("tr", null, [
          el("td", null, [el("span", { class: "err" + (ok ? " ok" : ""), text: code })]),
          el("td", { text: (responses[code] && responses[code].description) || "" }),
        ]));
      });
      details.appendChild(el("p", { class: "desc", text: "Responses" }));
      details.appendChild(rtable);

      container.appendChild(details);
    });
  });
})();
</script>
</body>
</html>`;
