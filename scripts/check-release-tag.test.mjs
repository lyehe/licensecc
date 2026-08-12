import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkPlatformTag, expectedPlatformTag } from "./check-release-tag.mjs";

test("binds a platform tag to the exact version authority", () => {
  const root = mkdtempSync(join(tmpdir(), "licensecc-release-tag-"));
  try {
    writeFileSync(join(root, "version.json"), '{"schema_version":1,"platform_version":"0.1.0-rc.1"}\n');
    assert.equal(expectedPlatformTag(root), "platform-v0.1.0-rc.1");
    assert.equal(checkPlatformTag("platform-v0.1.0-rc.1", root), "platform-v0.1.0-rc.1");
    for (const tag of ["v0.1.0-rc.1", "cpp-v2.1.0", "platform-v0.1.0", "platform-v0.1.0-rc.2", ""]) {
      assert.throws(() => checkPlatformTag(tag, root), /exactly platform-v0\.1\.0-rc\.1/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects malformed and extended version authorities", () => {
  for (const source of ['{"schema_version":2,"platform_version":"0.1.0"}', '{"schema_version":1,"platform_version":"0.1"}', "not-json"]) {
    const root = mkdtempSync(join(tmpdir(), "licensecc-release-tag-invalid-"));
    try {
      writeFileSync(join(root, "version.json"), source);
      assert.throws(() => expectedPlatformTag(root), /version\.json/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
