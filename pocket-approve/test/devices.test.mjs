import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceStore } from "../lib/devices.mjs";

async function dir(t) {
  const value = await mkdtemp(join(tmpdir(), "pa-devices-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

test("creates a device with a one-time token and stores only a hash", async (t) => {
  const dataDir = await dir(t);
  const store = createDeviceStore({ dataDir });
  await store.init();
  const { device, token } = await store.create("Ada's iPhone");
  assert.match(device.id, /^dev_[a-f0-9]{8}$/);
  assert.equal(device.name, "Ada's iPhone");
  assert.equal(device.tokenHash.startsWith("sha256:"), true);
  assert.equal(device.tokenPrefix, "pk_" + token.slice(0, 6));
  assert.deepEqual(device.scopes, ["read", "approve"]);
  assert.equal((await store.findActive(token)).id, device.id);
  assert.equal(await store.findActive("wrong"), null);
  const file = await readFile(join(dataDir, "devices.json"), "utf8");
  assert.equal(file.includes(token), false);
  assert.equal((await stat(join(dataDir, "devices.json"))).mode & 0o777, 0o600);
});

test("revocation is immediate and lastSeen writes are throttled", async (t) => {
  let clock = Date.parse("2026-10-25T12:00:00.000Z");
  const store = createDeviceStore({
    dataDir: await dir(t),
    now: () => new Date(clock),
  });
  await store.init();
  const { device, token } = await store.create("Pixel");
  await store.touch(device.id);
  assert.equal((await store.get(device.id)).lastSeenAt, "2026-10-25T12:00:00.000Z");
  clock += 30_000;
  await store.touch(device.id);
  assert.equal((await store.get(device.id)).lastSeenAt, "2026-10-25T12:00:00.000Z");
  clock += 31_000;
  await store.touch(device.id);
  assert.equal((await store.get(device.id)).lastSeenAt, "2026-10-25T12:01:01.000Z");
  await store.revoke(device.id);
  assert.equal(await store.findActive(token), null);
  assert.equal((await store.list())[0].revokedAt, "2026-10-25T12:01:01.000Z");
});

test("names are trimmed, capped, and required", async (t) => {
  const store = createDeviceStore({ dataDir: await dir(t) });
  await store.init();
  await assert.rejects(store.create(""), /name/i);
  await assert.rejects(store.create("x".repeat(65)), /name/i);
  const { device } = await store.create("  Phone  ");
  assert.equal(device.name, "Phone");
});
