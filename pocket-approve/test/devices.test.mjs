import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceStore } from "../lib/devices.mjs";
import { writePrivateJson } from "../lib/store.mjs";

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

test("concurrent writes to different files keep their own content and leak no temp files", async (t) => {
  const dataDir = await dir(t);
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    await Promise.all([
      writePrivateJson(join(dataDir, "devices.json"), { kind: "devices" }),
      writePrivateJson(join(dataDir, "pairing.json"), { kind: "pairing" }),
    ]);
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, "devices.json"), "utf8")), {
    kind: "devices",
  });
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, "pairing.json"), "utf8")), {
    kind: "pairing",
  });
  assert.deepEqual((await readdir(dataDir)).sort(), ["devices.json", "pairing.json"]);
});

test("concurrent creates all persist and a reload sees every record", async (t) => {
  const dataDir = await dir(t);
  const store = createDeviceStore({ dataDir });
  await store.init();
  const created = await Promise.all(
    Array.from({ length: 25 }, (_, index) => store.create(`Phone ${index}`)),
  );
  assert.equal(created.length, 25);
  assert.equal(store.list().length, 25);
  assert.equal(new Set(created.map(({ device }) => device.id)).size, 25);
  const onDisk = JSON.parse(await readFile(join(dataDir, "devices.json"), "utf8"));
  assert.equal(onDisk.length, 25);
  const reloaded = createDeviceStore({ dataDir });
  await reloaded.init();
  assert.equal(reloaded.list().length, 25);
  assert.equal(reloaded.activeCount(), 25);
  for (const { device, token } of created) {
    assert.equal((await reloaded.findActive(token)).id, device.id);
  }
});

test("a queued touch cannot resurrect a revocation on disk", async (t) => {
  let clock = Date.parse("2026-10-25T12:00:00.000Z");
  const dataDir = await dir(t);
  const store = createDeviceStore({ dataDir, now: () => new Date(clock) });
  await store.init();
  const { device, token } = await store.create("Pixel");
  clock += 61_000;
  const touched = store.touch(device.id);
  const revoked = store.revoke(device.id);
  await Promise.all([touched, revoked]);
  const reloaded = createDeviceStore({ dataDir });
  await reloaded.init();
  assert.equal(await reloaded.findActive(token), null);
});

test("data directory is private", async (t) => {
  const dataDir = await dir(t);
  const store = createDeviceStore({ dataDir });
  await store.init();
  await store.create("Phone");
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dataDir, "devices.json"))).mode & 0o777, 0o600);
});
