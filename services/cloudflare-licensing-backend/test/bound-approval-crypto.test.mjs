import test from "node:test";
import assert from "node:assert/strict";
import { sealBoundApproval, openBoundApproval } from "../src/device/bound_approval_crypto.mjs";
import { boundRandomId } from "../src/device/bound_enrollment.mjs";

test("approval ciphertext hides callback material and binds attempt plus approved revision", async () => {
  const ring=JSON.stringify({active:"a1",keys:{a1:boundRandomId(32)}}),hash="a".repeat(64);
  const value={operation_id:boundRandomId(32),response:{callback_url:"http://127.0.0.1:45678/callback?code=short-lived-code&state=state"}};
  const encrypted=await sealBoundApproval(value,hash,2,ring);
  assert.equal(encrypted.includes("short-lived-code"),false);
  assert.deepEqual(await openBoundApproval(encrypted,hash,2,ring),value);
  await assert.rejects(openBoundApproval(encrypted,"b".repeat(64),2,ring));
  await assert.rejects(openBoundApproval(encrypted,hash,3,ring));
  const parts=encrypted.split(".");parts[3]=(parts[3][0]==="A"?"B":"A")+parts[3].slice(1);
  await assert.rejects(openBoundApproval(parts.join("."),hash,2,ring));
  assert.notEqual(await sealBoundApproval(value,hash,2,ring),encrypted);
});

test("approval key rotation permits only explicitly retained brief decryption overlap", async () => {
  const old=boundRandomId(32),next=boundRandomId(32),hash="a".repeat(64);
  const encrypted=await sealBoundApproval({code:"temporary"},hash,1,JSON.stringify({active:"old",keys:{old}}));
  const overlap=JSON.stringify({active:"next",keys:{old,next}});
  assert.deepEqual(await openBoundApproval(encrypted,hash,1,overlap),{code:"temporary"});
  assert.match(await sealBoundApproval({code:"new"},hash,1,overlap),/^lccac1\.next\./);
  await assert.rejects(openBoundApproval(encrypted,hash,1,JSON.stringify({active:"next",keys:{next}})));
  for(const ring of [undefined,"{}",JSON.stringify({active:"missing",keys:{old}}),JSON.stringify({active:"bad.key",keys:{"bad.key":old}})]) await assert.rejects(sealBoundApproval({},hash,1,ring));
  await assert.rejects(sealBoundApproval({data:"x".repeat(4096)},hash,1,overlap));
});
