import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { build } = wranglerRequire("esbuild");

test("OAuth provider exchange uses workerd-supported requests and rejects redirects", async t => {
  const bundled = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      contents: `
import { exchangeIdentity } from './src/worker/oauth/providers.ts';
export default { async fetch(request) {
  const redirect = new URL(request.url).searchParams.has('redirect');
  const calls = [];
  globalThis.fetch = async (url, init) => {
    // Construct a real workerd Request: Node mocks accept unsupported redirect modes.
    const outgoing = new Request(url, init);
    calls.push({ url: outgoing.url, redirect: outgoing.redirect });
    if (redirect) return new Response(null, {status: 302, headers: {location: 'https://untrusted.test/'}});
    if (url.endsWith('/access_token')) return Response.json({access_token:'fixture-token',token_type:'bearer'});
    if (url.endsWith('/user')) return Response.json({id:123,name:'Fixture'});
    return Response.json([{email:'fixture@example.com',primary:true,verified:true}]);
  };
  try {
    const identity = await exchangeIdentity({PORTAL_GITHUB_CLIENT_ID:'fixture',PORTAL_GITHUB_CLIENT_SECRET:'fixture'}, 'github', 'code', 'verifier', 'nonce', 'https://portal.test/callback', 0);
    return Response.json({identity,calls});
  } catch (error) { return Response.json({error:error.message,calls}); }
}};`,
    },
    bundle: true, write: false, format: "esm", platform: "browser",
  });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "oauth-runtime-test", modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-06-05",
  }] }));
  t.after(() => mf.dispose());
  const success = await (await mf.dispatchFetch("https://portal.test/")).json();
  assert.equal(success.error, undefined);
  assert.equal(success.identity.subject, "123");
  assert.equal(success.calls.length, 3);
  assert.ok(success.calls.every(call => call.redirect === "manual"));
  const denied = await (await mf.dispatchFetch("https://portal.test/?redirect")).json();
  assert.equal(denied.error, "provider_unavailable");
  assert.equal(denied.calls.length, 1);
  assert.equal(denied.calls[0].url, "https://github.com/login/oauth/access_token");
});
