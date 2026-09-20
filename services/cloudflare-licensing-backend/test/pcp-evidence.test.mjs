import { test } from 'node:test';
import { checkPcpEvidenceConsistency as check } from '../src/device/pcp_evidence.mjs';
import { parseUntrustedPcpAk } from '../src/device/pcp_ak.mjs';
import { registerPcpEvidenceCases } from './helpers/pcp-evidence-cases.mjs';

registerPcpEvidenceCases(test, {
  check,
  parseAk: async value => parseUntrustedPcpAk(value),
  checkAndMutate: async (claim, expected) => {
    const pending = check(claim, expected);
    claim.fill(0); expected.nonce = ''; expected.subjectSpki = ''; expected.akSpki = ''; expected.akTpmPublic = '';
    return pending;
  },
});
