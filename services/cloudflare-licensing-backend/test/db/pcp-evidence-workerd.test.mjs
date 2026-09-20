import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { registerPcpEvidenceCases } from '../helpers/pcp-evidence-cases.mjs';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');

test('local workerd executes the complete PCP evidence consistency matrix', { timeout: 120_000 }, async t => {
  const bundled = await build({ stdin: { resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
    sourcefile: 'pcp-test-worker.mjs', contents: `
import {checkPcpEvidenceConsistency as check} from './src/device/pcp_evidence.mjs';
import {parseUntrustedPcpAk} from './src/device/pcp_ak.mjs';
import {decodeBase64url} from '@licensecc/licensing-domain/lease/device_protocol';
export default { async fetch(request) {
  const {operation,claim,expected,value}=await request.json();
  if(operation==='parse') {
    try {const result=parseUntrustedPcpAk(value);return Response.json({modulus:Array.from(result.modulus)});}
    catch(error) {return Response.json({error:error instanceof Error?error.message:'unexpected_parser_failure'});}
  }
  const bytes=decodeBase64url(claim,2048);
  const pending=check(bytes,expected);
  if(operation==='mutate') {
    bytes.fill(0);expected.nonce='';expected.subjectSpki='';expected.akSpki='';expected.akTpmPublic='';
  }
  const result=await pending;
  return Response.json({result,frozen:result===null||Object.isFrozen(result)});
}};` }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'pcp-evidence-test',
    modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-08-01' }] }));
  t.after(() => mf.dispose());
  const dispatch = async body => {
    const response = await mf.dispatchFetch('http://localhost/pcp-test', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 200, 'test Worker must complete normally');
    return response.json();
  };
  const check = async (operation, claim, expected) => {
    const response = await dispatch({ operation, claim: Buffer.from(claim).toString('base64url'), expected });
    assert.equal(response.frozen, true, 'result must be frozen inside workerd before serialization');
    // JSON cannot preserve frozen state; restore it only after checking runtime evidence.
    return response.result === null ? null : Object.freeze(response.result);
  };
  const cases = [];
  registerPcpEvidenceCases((name, run) => cases.push({ name, run }), {
    check: (claim, expected) => check('check', claim, expected),
    checkAndMutate: (claim, expected) => check('mutate', claim, expected),
    parseAk: async value => {
      const response = await dispatch({ operation: 'parse', value });
      if (response.error) throw new Error(response.error);
      return { modulus: Uint8Array.from(response.modulus) };
    },
  });
  for (const { name, run } of cases) await t.test(name, run);
});
