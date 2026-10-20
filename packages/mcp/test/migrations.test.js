/**
 * Schema changes are new entries in the migrations list, never edits to applied ones
 * (CLAUDE.md, docs/development.md). This pins the digest of every migration that has
 * shipped: changing one of them fails here, adding version N+1 only requires appending
 * its digest below (print it with `node -e 'import("@duskfleet/core").then(c => console.log(c.migrationDigests()))'`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { migrationDigests } from "@duskfleet/core";

const SHIPPED = [
  { version: 1, sha256: "fa4707e3426fb48a34fca28313df083b19ee87ea45efd2ffefa7cd2cb3248ee8" },
  { version: 2, sha256: "406502037c695d770926f19c249847373402adb4f87a10cf6e7fd42b6ddafb94" },
  { version: 3, sha256: "4ab1916ce01188d8eda5c327bbfb992adbb97f6d41755f68785c9a6a5d115b93" },
  { version: 4, sha256: "9b71614f0ef3413508a0204aea15fb54f8974f9529e3b9a1eda9d5c806d0782e" },
  { version: 5, sha256: "362303ef1453593bf24b736a2e52626d78696bd7ccbd9a5b80db15b91070dd52" },
  { version: 6, sha256: "96492ffe77e5fa2bd9b256d317fd4f11a6a3b56fe82978680fadce44649f3734" },
  { version: 7, sha256: "6cc9b8cb42b8b4b581eacdb51a6748444f40c179dc3cf4b6c8eb89a2ce923e98" },
  { version: 8, sha256: "46ba5171a209ea14130a172a505b7188af26f95e024a107764aa0c1240bd96af" },
  { version: 9, sha256: "ca678b0e4e98c1baefd986778b329fa8f870650f8441d3ec39abbac6702a6f85" },
  { version: 10, sha256: "2e76d46da90a55c06ca8e6298f95e54fb94de3d479ac13973dc8543a0d348112" },
  { version: 11, sha256: "af336cc559b3e0663276d53ccd3e292f4ae8e402031fe13f23a4ad45158de448" },
  { version: 12, sha256: "c294406e3c2a07d81709a588bf76cf4f956ce9263d4edd550bddac74d8029ad9" },
  { version: 13, sha256: "92773f05128dd2ff416b962b67b4e33ec585422b7d804611c5de8219e45075e5" },
  { version: 14, sha256: "ccbcf51e17e27bd962e1d488a3c43649e6a594283cf428f8cbe3f9f7291985d4" },
];

test("shipped migrations are never edited, only appended to", () => {
  const current = migrationDigests();
  assert.ok(current.length >= SHIPPED.length, "a shipped migration was removed");
  for (const [i, shipped] of SHIPPED.entries()) {
    const m = current[i];
    assert.equal(m.version, shipped.version, `migration at position ${i} changed version`);
    assert.equal(
      m.sha256,
      shipped.sha256,
      `migration ${shipped.version} was edited: existing databases already applied the old SQL; add a new migration instead`,
    );
  }
  for (const m of current.slice(SHIPPED.length)) {
    assert.fail(
      `migration ${m.version} is not pinned in test/migrations.test.js: append { version: ${m.version}, sha256: "${m.sha256}" } once it is final`,
    );
  }
});

test("migration versions are consecutive from 1", () => {
  const versions = migrationDigests().map((m) => m.version);
  assert.deepEqual(
    versions,
    versions.map((_, i) => i + 1),
  );
});
