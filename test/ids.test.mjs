import test from "node:test";
import assert from "node:assert/strict";
import { namespacedId, parseNamespacedId } from "../lib/ids.mjs";

test("namespaced ids split at the first colon", () => {
  assert.equal(namespacedId("local", "per_1"), "local:per_1");
  assert.deepEqual(parseNamespacedId("local:per:1"), { serverId: "local", rawId: "per:1" });
  assert.equal(parseNamespacedId("per_1"), null);
  assert.equal(parseNamespacedId(":per_1"), null);
  assert.equal(parseNamespacedId("local:"), null);
});
