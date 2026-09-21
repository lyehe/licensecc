import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { build } = wranglerRequire("esbuild");

test("workerd streams scanned exports to R2 and rejects length mismatches", { timeout: 120_000 }, async t => {
  const bundled = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      contents: `
import { saveD1ExportToR2 } from './src/core.ts';
export default { async fetch(request, env) {
  const { delta, encoding } = await request.json();
  const sql = "CREATE TABLE customers (id TEXT); INSERT INTO customers VALUES ('one');";
  const bytes = new TextEncoder().encode(sql);
  const headers = { 'content-length': String(bytes.length + delta) };
  if (encoding) headers['content-encoding'] = encoding;
  try {
    const result = await saveD1ExportToR2(env.BUCKET,
      async () => new Response(new ReadableStream({ start(c) {
        c.enqueue(bytes.slice(0, 7)); c.enqueue(bytes.slice(7)); c.close();
      } }), { headers }),
      { accountId: 'test', databaseId: 'test', databaseName: 'test', prefix: 'test', retentionDays: 7 },
      { bookmark: 'test', snapshotRequestedAt: '2026-01-01T00:00:00.000Z' },
      { filename: 'dump.sql', signedUrl: 'https://example.test/dump' });
    return Response.json({ result, sql: await (await env.BUCKET.get(result.object_key)).text() });
  } catch (error) { return Response.json({ error: error.message }); }
}};`,
    },
    bundle: true, write: false, format: "esm", platform: "browser", external: ["node:crypto"],
  });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "backup-runtime-test", modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"], r2Buckets: ["BUCKET"],
  }] }));
  t.after(() => mf.dispose());
  const bucket = await mf.getR2Bucket("BUCKET");
  for (const scenario of [{ delta: -1 }, { delta: 1 }, { delta: 0, encoding: "gzip" }, { delta: 0 }]) {
    const response = await mf.dispatchFetch("https://example.test/", { method: "POST", body: JSON.stringify(scenario) });
    assert.equal(response.status, 200);
    const value = await response.json();
    if (scenario.delta !== 0 || scenario.encoding) {
      assert.ok(value.error, JSON.stringify(value));
      assert.equal((await bucket.list()).objects.some(o => o.key.endsWith(".metadata.json")), false);
    } else {
      assert.equal(value.error, undefined);
      assert.deepEqual(value.result.snapshot_inventory.table_counts, { customers: 1 });
      assert.equal(value.result.content_integrity.size_bytes, Buffer.byteLength(value.sql));
      assert.ok(await bucket.get(value.result.manifest_key));
    }
  }
});
