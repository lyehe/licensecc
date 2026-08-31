import { HTML_NONCE_PLACEHOLDER } from "@licensecc/cloudflare-runtime/http/kit";

// Self-contained docs page: no external CDN, no network beyond /openapi.json. Fetches the spec and
// renders a grouped, collapsible endpoint list. Kept deliberately minimal and dependency-free.
export const docsHtml: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>licensecc licensing-backend API</title>
<style nonce="${HTML_NONCE_PLACEHOLDER}">
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 0 1rem 4rem; max-width: 960px; }
  h1 { font-size: 1.5rem; }
  .tag-group { margin: 1.5rem 0; }
  .tag-group > h2 { font-size: 1.1rem; border-bottom: 1px solid #8884; padding-bottom: .25rem; }
  details { border: 1px solid #8884; border-radius: 6px; margin: .4rem 0; padding: .25rem .6rem; }
  summary { cursor: pointer; display: flex; gap: .6rem; align-items: baseline; }
  summary::-webkit-details-marker { display: none; }
  .method { font-weight: 700; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; padding: .1rem .4rem; border-radius: 4px; min-width: 3.2rem; text-align: center; color: #fff; }
  .m-get { background: #2f855a; } .m-post { background: #2b6cb0; } .m-put { background: #b7791f; } .m-delete { background: #c53030; }
  .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
  .summary-text { color: #888; flex: 1; }
  .detail-body { margin-top: .6rem; }
  .sec { font-size: .8rem; color: #888; margin: .3rem 0; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; margin: .4rem 0; }
  th, td { text-align: left; border: 1px solid #8884; padding: .2rem .45rem; vertical-align: top; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #8882; padding: 0 .25rem; border-radius: 3px; }
  .err-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .loading, .error { color: #888; padding: 2rem 0; }
</style>
</head>
<body>
<h1>licensecc licensing-backend API</h1>
<p class="sec">OpenAPI 3.1 doc-of-existing. Source of truth: <a href="/openapi.json">/openapi.json</a>.</p>
<div id="app"><p class="loading">Loading spec…</p></div>
<script nonce="${HTML_NONCE_PLACEHOLDER}">
(function () {
  var app = document.getElementById("app");
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function appendRow(table, values, header) {
    var row = el("tr");
    values.forEach(function (value) {
      var cell = el(header ? "th" : "td");
      if (value && value.code) cell.appendChild(el("code", null, value.text));
      else cell.textContent = String(value && value.text !== undefined ? value.text : value);
      row.appendChild(cell);
    });
    table.appendChild(row);
  }
  function methodClass(m) { return "method m-" + m.toLowerCase(); }
  function render(spec) {
    app.replaceChildren();
    var info = spec.info || {};
    var head = el("p", "sec", (info.title || "") + " v" + (info.version || ""));
    app.appendChild(head);
    var paths = spec.paths || {};
    var groups = {};
    var order = [];
    Object.keys(paths).forEach(function (p) {
      Object.keys(paths[p]).forEach(function (method) {
        var op = paths[p][method];
        var tag = (op.tags && op.tags[0]) || "other";
        if (!groups[tag]) { groups[tag] = []; order.push(tag); }
        groups[tag].push({ path: p, method: method.toUpperCase(), op: op });
      });
    });
    order.forEach(function (tag) {
      var g = document.createElement("div");
      g.className = "tag-group";
      var h = document.createElement("h2");
      h.textContent = tag;
      g.appendChild(h);
      groups[tag].forEach(function (e) {
        g.appendChild(renderEndpoint(e, spec));
      });
      app.appendChild(g);
    });
  }
  function refName(ref) { return ref ? ref.split("/").pop() : ""; }
  function renderEndpoint(e, spec) {
    var d = el("details");
    var s = el("summary");
    s.appendChild(el("span", methodClass(e.method), e.method));
    s.appendChild(el("span", "path", e.path));
    s.appendChild(el("span", "summary-text", e.op.summary || ""));
    d.appendChild(s);
    var body = el("div", "detail-body");
    if (e.op.description) body.appendChild(el("p", null, e.op.description));
    var sec = (e.op.security || []).map(function (o) { return Object.keys(o)[0]; }).filter(Boolean);
    body.appendChild(el("p", "sec", "Security: " + (sec.length ? sec.join(" OR ") : "none")));
    if (e.op.parameters && e.op.parameters.length) {
      body.appendChild(el("p", "sec", "Parameters"));
      var params = el("table");
      appendRow(params, ["name", "in", "required", "type"], true);
      e.op.parameters.forEach(function (p) {
        var t = (p.schema && (p.schema.type || (p.schema.$ref ? refName(p.schema.$ref) : ""))) || "";
        appendRow(params, [{ code: true, text: p.name }, p.in, p.required ? "yes" : "no", t], false);
      });
      body.appendChild(params);
    }
    if (e.op.requestBody) {
      var rb = e.op.requestBody.content && e.op.requestBody.content["application/json"];
      var ref = rb && rb.schema && rb.schema.$ref ? refName(rb.schema.$ref) : "(json)";
      var requestBody = el("p", "sec", "Request body: ");
      requestBody.appendChild(el("code", null, ref));
      body.appendChild(requestBody);
      var schema = renderSchema(spec, ref);
      if (schema) body.appendChild(schema);
    }
    body.appendChild(el("p", "sec", "Responses"));
    var responses = el("table");
    appendRow(responses, ["status", "description"], true);
    Object.keys(e.op.responses || {}).forEach(function (code) {
      appendRow(responses, [code, (e.op.responses[code] && e.op.responses[code].description) || ""], false);
    });
    body.appendChild(responses);
    d.appendChild(body);
    return d;
  }
  function renderSchema(spec, name) {
    var schemas = (spec.components && spec.components.schemas) || {};
    var sc = schemas[name];
    if (!sc || !sc.properties) return null;
    var req = sc.required || [];
    var table = el("table");
    appendRow(table, ["field", "type", "required"], true);
    Object.keys(sc.properties).forEach(function (k) {
      var p = sc.properties[k];
      var t = p.type;
      if (Array.isArray(t)) t = t.join("|");
      if (p.enum) t = (t || "enum") + " (" + p.enum.join(", ") + ")";
      appendRow(table, [{ code: true, text: k }, t || "", req.indexOf(k) >= 0 ? "yes" : "no"], false);
    });
    return table;
  }
  fetch("/openapi.json").then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(render).catch(function (err) {
    app.replaceChildren(el("p", "error", "Failed to load /openapi.json: " + (err && err.message)));
  });
})();
</script>
</body>
</html>`;
