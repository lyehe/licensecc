// Self-contained HTML API reference for GET /docs.
//
// No external CDN / no network dependency: the page fetches the same Worker's
// /openapi.json at runtime and renders a grouped, collapsible endpoint list with
// plain DOM + inline CSS. Kept deliberately minimal.

export const docsHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>License Admin API</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0f1115; color: #e6e6e6; }
  header { padding: 20px 24px; border-bottom: 1px solid #262a33; background: #14171d; position: sticky; top: 0; z-index: 2; }
  header h1 { margin: 0 0 4px; font-size: 18px; }
  header p { margin: 0; color: #9aa3b2; font-size: 12px; }
  header a { color: #6ea8fe; }
  main { padding: 16px 24px 64px; max-width: 1000px; }
  .group { margin: 22px 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #8b94a3; }
  details { border: 1px solid #262a33; border-radius: 6px; margin: 8px 0; background: #161922; }
  details[open] { border-color: #313847; }
  summary { cursor: pointer; padding: 10px 12px; display: flex; align-items: center; gap: 10px; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  .method { font-weight: 700; font-size: 11px; padding: 2px 8px; border-radius: 4px; min-width: 56px; text-align: center; }
  .m-GET { background: #11341f; color: #7ee2a8; }
  .m-POST { background: #1d2f4d; color: #7fb2ff; }
  .m-PATCH { background: #3a2c14; color: #f0c674; }
  .path { color: #e6e6e6; }
  .sm { color: #9aa3b2; font-size: 12px; margin-left: auto; text-align: right; }
  .body { padding: 4px 14px 14px; border-top: 1px solid #262a33; }
  .body h4 { margin: 12px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8b94a3; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  td, th { text-align: left; padding: 3px 8px 3px 0; vertical-align: top; }
  th { color: #8b94a3; font-weight: 600; }
  code { background: #0c0e13; padding: 1px 5px; border-radius: 3px; }
  .err td:first-child { color: #f49; }
  .sec { color: #c8a; }
  .muted { color: #6b7280; }
  .err-code { color: #f08aa8; }
</style>
</head>
<body>
<header>
  <h1 id="title">License Admin API</h1>
  <p id="subtitle">Loading <a href="/openapi.json">/openapi.json</a> &hellip;</p>
</header>
<main id="root"><p class="muted">Loading&hellip;</p></main>
<script>
(function () {
  var METHODS = ["get", "post", "patch", "put", "delete", "options", "head"];
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function refName(ref) { return typeof ref === "string" ? ref.split("/").pop() : ""; }
  function statusList(responses) {
    var t = el("table");
    var head = el("tr");
    head.appendChild(el("th", null, "status"));
    head.appendChild(el("th", null, "codes / description"));
    t.appendChild(head);
    Object.keys(responses || {}).sort().forEach(function (status) {
      var r = responses[status] || {};
      var tr = el("tr", Number(status) >= 400 ? "err" : null);
      tr.appendChild(el("td", null, status));
      var td = el("td");
      var codes = [];
      var content = (r.content && r.content["application/json"]) || {};
      if (content.examples) codes = Object.keys(content.examples);
      var desc = el("span", null, r.description || "");
      td.appendChild(desc);
      if (codes.length) {
        td.appendChild(document.createTextNode(" "));
        codes.forEach(function (c, i) {
          if (i) td.appendChild(document.createTextNode(" "));
          td.appendChild(el("code", "err-code", c));
        });
      }
      tr.appendChild(td);
      t.appendChild(tr);
    });
    return t;
  }
  function paramRows(params) {
    if (!params || !params.length) return null;
    var t = el("table");
    var head = el("tr");
    ["name", "in", "required", "description"].forEach(function (h) { head.appendChild(el("th", null, h)); });
    t.appendChild(head);
    params.forEach(function (p) {
      var tr = el("tr");
      tr.appendChild(el("td", null, p.name));
      tr.appendChild(el("td", null, p.in));
      tr.appendChild(el("td", null, p.required ? "yes" : "no"));
      tr.appendChild(el("td", null, p.description || ""));
      t.appendChild(tr);
    });
    return t;
  }
  function render(spec) {
    document.getElementById("title").textContent = (spec.info && spec.info.title) || "API";
    var sub = document.getElementById("subtitle");
    sub.textContent = "v" + ((spec.info && spec.info.version) || "?") + " · " + Object.keys(spec.paths || {}).length + " paths";
    var root = document.getElementById("root");
    root.innerHTML = "";

    var groups = {};
    var order = [];
    Object.keys(spec.paths || {}).forEach(function (path) {
      var item = spec.paths[path];
      METHODS.forEach(function (method) {
        if (!item[method]) return;
        var op = item[method];
        var tag = (op.tags && op.tags[0]) || "other";
        if (!groups[tag]) { groups[tag] = []; order.push(tag); }
        groups[tag].push({ path: path, method: method.toUpperCase(), op: op });
      });
    });
    order.sort();
    order.forEach(function (tag) {
      root.appendChild(el("div", "group", tag));
      groups[tag].forEach(function (entry) {
        var d = el("details");
        var s = el("summary");
        s.appendChild(el("span", "method m-" + entry.method, entry.method));
        s.appendChild(el("span", "path", entry.path));
        s.appendChild(el("span", "sm", entry.op.summary || ""));
        d.appendChild(s);

        var body = el("div", "body");
        if (entry.op.security) {
          var schemes = entry.op.security.map(function (s) { return Object.keys(s)[0]; }).filter(Boolean);
          body.appendChild(el("h4", null, "auth"));
          body.appendChild(el("div", "sec", schemes.length ? schemes.join(" OR ") : "none (public)"));
        }
        var params = paramRows(entry.op.parameters);
        if (params) { body.appendChild(el("h4", null, "parameters")); body.appendChild(params); }
        if (entry.op.requestBody) {
          var rb = entry.op.requestBody;
          var schema = ((((rb.content || {})["application/json"]) || {}).schema) || {};
          body.appendChild(el("h4", null, "request body" + (rb.required ? " (required)" : " (optional)")));
          var ref = refName(schema.$ref);
          body.appendChild(el("code", null, ref || (rb.description || "json")));
        }
        body.appendChild(el("h4", null, "responses"));
        body.appendChild(statusList(entry.op.responses));
        d.appendChild(body);
        root.appendChild(d);
      });
    });
  }
  fetch("/openapi.json").then(function (r) { return r.json(); }).then(render).catch(function (e) {
    document.getElementById("root").innerHTML = "<p>Failed to load /openapi.json: " + String(e) + "</p>";
  });
})();
</script>
</body>
</html>`;
