import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSeenStore } from "../lib/seen.mjs";
import { writePrivateJson } from "../lib/store.mjs";

async function dir(t) {
  const value = await mkdtemp(join(tmpdir(), "pa-seen-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

test("takeNew marks before send and never repeats", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pa-seen-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = 1000;
  const seen = createSeenStore({ dataDir: dir, now: () => clock });
  await seen.init();
  assert.deepEqual((await seen.takeNew([{ id: "a" }, { id: "b" }])).map((x) => x.id), ["a", "b"]);
  assert.deepEqual(await seen.takeNew([{ id: "a" }]), []);
  clock += 1000;
  assert.deepEqual(await seen.takeNew([{ id: "a" }, { id: "c" }]).then((x) => x.map((y) => y.id)), ["c"]);
});

test("prunes after seven days or one hour after leaving every cache", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pa-seen-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = 0;
  const seen = createSeenStore({ dataDir: dir, now: () => clock });
  await seen.init();
  await seen.takeNew([{ id: "old" }, { id: "left" }, { id: "kept" }]);
  await seen.observe(new Set(["old", "left", "kept"]));
  clock = 3_600_001;
  await seen.observe(new Set(["old", "kept"]));
  assert.equal(seen.has("left"), false);
  assert.equal(seen.has("kept"), true);
  clock = 604_800_001;
  await seen.observe(new Set(["kept"]));
  assert.equal(seen.has("old"), false);
  assert.equal(seen.has("kept"), false);
});

test("has and size reflect only valid marked ids", async (t) => {
  const seen = createSeenStore({ dataDir: await dir(t), now: () => 0 });
  await seen.init();
  assert.equal(seen.has("srv:a"), false);
  assert.equal(seen.has("__proto__"), false);
  assert.equal(seen.size(), 0);
  assert.deepEqual(await seen.takeNew([{ id: "" }, null, {}, { id: "srv:a" }, { id: "srv:a" }]), [
    { id: "srv:a" },
  ]);
  assert.equal(seen.has("srv:a"), true);
  assert.equal(seen.has("srv:missing"), false);
  assert.equal(seen.size(), 1);
});

test("records persist across a reload with private file mode", async (t) => {
  const dataDir = await dir(t);
  const first = createSeenStore({ dataDir, now: () => 0 });
  await first.init();
  await first.takeNew([{ id: "srv:a" }, { id: "srv:b" }]);
  await first.observe(new Set(["srv:a"]));
  const second = createSeenStore({ dataDir, now: () => 0 });
  await second.init();
  assert.equal(second.size(), 2);
  assert.equal(second.has("srv:a"), true);
  assert.equal(second.has("srv:b"), true);
  assert.deepEqual(await second.takeNew([{ id: "srv:b" }]), []);
  assert.deepEqual((await second.takeNew([{ id: "srv:c" }])).map((x) => x.id), ["srv:c"]);
  assert.equal((await stat(join(dataDir, "seen.json"))).mode & 0o777, 0o600);
});

test("concurrent takeNew and observe calls preserve every record", async (t) => {
  const dataDir = await dir(t);
  const seen = createSeenStore({ dataDir, now: () => 0 });
  await seen.init();
  const batches = Array.from({ length: 20 }, (_, index) => [{ id: `srv:${index}` }]);
  await Promise.all([
    ...batches.map((batch) => seen.takeNew(batch)),
    seen.observe(new Set()),
    seen.observe(["srv:0"]),
    seen.takeNew([{ id: "srv:0" }, { id: "srv:extra" }]),
  ]);
  assert.equal(seen.size(), 21);
  for (let index = 0; index < 20; index += 1) assert.equal(seen.has(`srv:${index}`), true);
  assert.equal(seen.has("srv:extra"), true);
  const contents = JSON.parse(await readFile(join(dataDir, "seen.json"), "utf8"));
  assert.equal(Object.keys(contents).length, 21);
  const reloaded = createSeenStore({ dataDir, now: () => 0 });
  await reloaded.init();
  assert.equal(reloaded.size(), 21);
});

test("a still-present id is pruned once it is older than seven days", async (t) => {
  let clock = 0;
  const seen = createSeenStore({ dataDir: await dir(t), now: () => clock });
  await seen.init();
  await seen.takeNew([{ id: "srv:age" }]);
  await seen.observe(new Set(["srv:age"]));
  clock = 604_800_000;
  await seen.observe(new Set(["srv:age"]));
  assert.equal(seen.has("srv:age"), true);
  clock = 604_800_001;
  await seen.observe(new Set(["srv:age"]));
  assert.equal(seen.has("srv:age"), false);
});

test("an absent id is pruned one hour after leaving every cache", async (t) => {
  let clock = 0;
  const seen = createSeenStore({ dataDir: await dir(t), now: () => clock });
  await seen.init();
  await seen.takeNew([{ id: "srv:left" }]);
  await seen.observe(["srv:left"]);
  clock = 3_600_000;
  await seen.observe([]);
  assert.equal(seen.has("srv:left"), true);
  clock = 3_600_001;
  await seen.observe(null);
  assert.equal(seen.has("srv:left"), false);
});

test("observe accepts missing ids without crashing and does not write when nothing changed", async (t) => {
  const dataDir = await dir(t);
  const seen = createSeenStore({ dataDir, now: () => 0 });
  await seen.init();
  await seen.takeNew([{ id: "srv:a" }]);
  await seen.observe(undefined);
  await seen.observe(new Set(["srv:a"]));
  const before = (await stat(join(dataDir, "seen.json"))).mtimeMs;
  await seen.observe(new Set(["srv:a"]));
  const after = (await stat(join(dataDir, "seen.json"))).mtimeMs;
  assert.equal(after, before);
  assert.equal(seen.has("srv:a"), true);
});

test("malformed JSON fails closed while non-object JSON falls back to empty", async (t) => {
  const brokenDir = await dir(t);
  await writeFile(join(brokenDir, "seen.json"), "{not json", { mode: 0o600 });
  const broken = createSeenStore({ dataDir: brokenDir, now: () => 0 });
  await assert.rejects(broken.init());
  assert.equal((await readFile(join(brokenDir, "seen.json"), "utf8")), "{not json");

  const shapeDir = await dir(t);
  await writePrivateJson(join(shapeDir, "seen.json"), ["not", "an", "object"]);
  const shape = createSeenStore({ dataDir: shapeDir, now: () => 0 });
  await shape.init();
  assert.equal(shape.size(), 0);
  assert.deepEqual((await shape.takeNew([{ id: "srv:a" }])).map((x) => x.id), ["srv:a"]);

  const mixedDir = await dir(t);
  await writePrivateJson(join(mixedDir, "seen.json"), {
    "srv:bad": "nope",
    "srv:nan": { firstSeenAt: "0", lastPresentAt: 0 },
    "srv:ok": { firstSeenAt: 5, lastPresentAt: 5 },
    "": { firstSeenAt: 5, lastPresentAt: 5 },
  });
  const mixed = createSeenStore({ dataDir: mixedDir, now: () => 0 });
  await mixed.init();
  assert.equal(mixed.size(), 1);
  assert.equal(mixed.has("srv:ok"), true);
});

test("takeNew rejects and leaves ids unmarked when persistence fails", async (t) => {
  const dataDir = await dir(t);
  const seen = createSeenStore({ dataDir, now: () => 0 });
  await seen.init();
  const blocker = join(dataDir, "seen.json");
  await mkdir(blocker);
  await assert.rejects(seen.takeNew([{ id: "srv:a" }]));
  assert.equal(seen.has("srv:a"), false);
  await rm(blocker, { recursive: true, force: true });
  assert.deepEqual((await seen.takeNew([{ id: "srv:a" }])).map((x) => x.id), ["srv:a"]);
  assert.equal(seen.has("srv:a"), true);
});

test("rejects invalid construction options", () => {
  assert.throws(() => createSeenStore(), TypeError);
  assert.throws(() => createSeenStore({ dataDir: "" }), TypeError);
  assert.throws(() => createSeenStore({ dataDir: "   " }), TypeError);
  assert.throws(() => createSeenStore({ dataDir: 42 }), TypeError);
  assert.throws(() => createSeenStore({ dataDir: "/tmp/pa-seen", ttlMs: 0 }), TypeError);
  assert.throws(() => createSeenStore({ dataDir: "/tmp/pa-seen", ttlMs: -1 }), TypeError);
  assert.throws(() => createSeenStore({ dataDir: "/tmp/pa-seen", ttlMs: Number.NaN }), TypeError);
  assert.throws(() => createSeenStore({ dataDir: "/tmp/pa-seen", ttlMs: Number.POSITIVE_INFINITY }), TypeError);
  assert.throws(() => createSeenStore({ dataDir: "/tmp/pa-seen", ttlMs: "100" }), TypeError);
  assert.throws(() => createSeenStore({ dataDir: "/tmp/pa-seen", absentTtlMs: 0 }), TypeError);
  assert.throws(() => createSeenStore({ dataDir: "/tmp/pa-seen", absentTtlMs: Number.NaN }), TypeError);
  assert.throws(() => createSeenStore({ dataDir: "/tmp/pa-seen", absentTtlMs: "100" }), TypeError);
  assert.throws(() => createSeenStore({ dataDir: "/tmp/pa-seen", now: 123 }), TypeError);
});

test("release removes records so a later takeNew returns the item again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pa-seen-"));
  const seen = createSeenStore({ dataDir: dir, now: () => 1000 });
  await seen.init();
  const item = { id: "alpha:1" };
  assert.deepEqual(await seen.takeNew([item]), [item]);
  assert.deepEqual(await seen.takeNew([item]), []);
  await seen.release(["alpha:1"]);
  assert.deepEqual(await seen.takeNew([item]), [item]);
});

test("takeNew collects at most the limit and leaves the rest for a later call", async (t) => {
  const seen = createSeenStore({ dataDir: await dir(t), now: () => 0 });
  await seen.init();
  const items = Array.from({ length: 25 }, (_, index) => ({ id: `srv:${index}` }));
  const first = await seen.takeNew(items, 20);
  assert.equal(first.length, 20);
  assert.equal(seen.has("srv:20"), false);
  const second = await seen.takeNew(items, 20);
  assert.deepEqual(second.map((item) => item.id), ["srv:20", "srv:21", "srv:22", "srv:23", "srv:24"]);
});
