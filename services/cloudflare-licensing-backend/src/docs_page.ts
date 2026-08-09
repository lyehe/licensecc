// Self-contained docs page: no external CDN, no network beyond /openapi.json. Fetches the spec and
// renders a grouped, collapsible endpoint list. Kept deliberately minimal and dependency-free.
export const docsHtml: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>licensecc licensing-backend API</title>
<style>
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
<script>
(function () {
  var app = document.getElementById("app");
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function methodClass(m) { return "method m-" + m.toLowerCase(); }
  function render(spec) {
    app.innerHTML = "";
    var info = spec.info || {};
    var head = document.createElement("p");
    head.className = "sec";
    head.textContent = (info.title || "") + " v" + (info.version || "");
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
    var d = document.createElement("details");
    var s = document.createElement("summary");
    s.innerHTML = '<span class="' + methodClass(e.method) + '">' + esc(e.method) + '</span>' +
      '<span class="path">' + esc(e.path) + '</span>' +
      '<span class="summary-text">' + esc(e.op.summary || "") + '</span>';
    d.appendChild(s);
    var body = document.createElement("div");
    body.className = "detail-body";
    var html = "";
    if (e.op.description) html += '<p>' + esc(e.op.description) + '</p>';
    var sec = (e.op.security || []).map(function (o) { return Object.keys(o)[0]; }).filter(Boolean);
    html += '<p class="sec">Security: ' + (sec.length ? sec.map(esc).join(" OR ") : "none") + '</p>';
    if (e.op.parameters && e.op.parameters.length) {
      html += '<p class="sec">Parameters</p><table><tr><th>name</th><th>in</th><th>required</th><th>type</th></tr>';
      e.op.parameters.forEach(function (p) {
        var t = (p.schema && (p.schema.type || (p.schema.$ref ? refName(p.schema.$ref) : ""))) || "";
        html += '<tr><td><code>' + esc(p.name) + '</code></td><td>' + esc(p.in) + '</td><td>' +
          (p.required ? "yes" : "no") + '</td><td>' + esc(t) + '</td></tr>';
      });
      html += '</table>';
    }
    if (e.op.requestBody) {
      var rb = e.op.requestBody.content && e.op.requestBody.content["application/json"];
      var ref = rb && rb.schema && rb.schema.$ref ? refName(rb.schema.$ref) : "(json)";
      html += '<p class="sec">Request body: <code>' + esc(ref) + '</code></p>';
      html += renderSchema(spec, ref);
    }
    html += '<p class="sec">Responses</p><table><tr><th>status</th><th>description</th></tr>';
    Object.keys(e.op.responses || {}).forEach(function (code) {
      html += '<tr><td class="err-code">' + esc(code) + '</td><td>' +
        esc((e.op.responses[code] && e.op.responses[code].description) || "") + '</td></tr>';
    });
    html += '</table>';
    body.innerHTML = html;
    d.appendChild(body);
    return d;
  }
  function renderSchema(spec, name) {
    var schemas = (spec.components && spec.components.schemas) || {};
    var sc = schemas[name];
    if (!sc || !sc.properties) return "";
    var req = sc.required || [];
    var html = '<table><tr><th>field</th><th>type</th><th>required</th></tr>';
    Object.keys(sc.properties).forEach(function (k) {
      var p = sc.properties[k];
      var t = p.type;
      if (Array.isArray(t)) t = t.join("|");
      if (p.enum) t = (t || "enum") + " (" + p.enum.join(", ") + ")";
      html += '<tr><td><code>' + esc(k) + '</code></td><td>' + esc(t || "") + '</td><td>' +
        (req.indexOf(k) >= 0 ? "yes" : "no") + '</td></tr>';
    });
    html += '</table>';
    return html;
  }
  fetch("/openapi.json").then(function (r) { return r.json(); }).then(render).catch(function (err) {
    app.innerHTML = '<p class="error">Failed to load /openapi.json: ' + esc(err && err.message) + '</p>';
  });
})();
</script>
</body>
</html>`;
