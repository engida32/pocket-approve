import test from "node:test";
import assert from "node:assert/strict";
import { createPoller } from "../lib/poller.mjs";

function sleeping(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("notifies once per id and recovers after an error", async () => {
  let calls = 0;
  const seen = [];
  const source = {
    list: async () => {
      calls++;
      if (calls === 2) throw new Error("down");
      return [{ id: "per_1" }];
    },
  };
  const poller = createPoller({
    source,
    onNew: async (r) => seen.push(r.id),
    intervalMs: 10_000,
  });
  await poller.tick();
  await poller.tick();
  await poller.tick();
  assert.deepEqual(seen, ["per_1"]);
});

test("forgets ids that disappear and notifies when they return", async () => {
  let calls = 0;
  const seen = [];
  const lists = [
    [{ id: "per_1" }, { id: "per_2" }],
    [{ id: "per_2" }],
    [{ id: "per_1" }, { id: "per_2" }],
  ];
  const poller = createPoller({
    source: {
      list: async () => lists[Math.min(calls++, lists.length - 1)],
    },
    onNew: async (r) => seen.push(r.id),
    intervalMs: 10_000,
  });
  await poller.tick();
  await poller.tick();
  await poller.tick();
  assert.deepEqual(seen, ["per_1", "per_2", "per_1"]);
});

test("logs only the first failure in a run and resets after success", async () => {
  const errors = [];
  let calls = 0;
  const seen = [];
  const poller = createPoller({
    source: {
      list: async () => {
        calls++;
        if (calls <= 2) throw new Error("down");
        if (calls === 3) return [{ id: "per_1" }];
        throw new Error("down again");
      },
    },
    onNew: async (r) => seen.push(r.id),
    intervalMs: 10_000,
    log: { error: (...args) => errors.push(args) },
  });
  await poller.tick();
  await poller.tick();
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /poller/i);
  await poller.tick();
  assert.deepEqual(seen, ["per_1"]);
  await poller.tick();
  assert.equal(errors.length, 2);
});

test("ignores entries without a usable id", async () => {
  const seen = [];
  const poller = createPoller({
    source: {
      list: async () => [null, {}, { id: "" }, { id: 7 }, { id: "per_1" }],
    },
    onNew: async (r) => seen.push(r.id),
    intervalMs: 10_000,
  });
  await poller.tick();
  assert.deepEqual(seen, ["per_1"]);
});

test("notifies once when a listing repeats an id", async () => {
  const seen = [];
  const poller = createPoller({
    source: { list: async () => [{ id: "per_1" }, { id: "per_1" }] },
    onNew: async (r) => seen.push(r.id),
    intervalMs: 10_000,
  });
  await poller.tick();
  assert.deepEqual(seen, ["per_1"]);
});

test("treats a non-array listing as empty", async () => {
  const seen = [];
  const poller = createPoller({
    source: { list: async () => ({ nope: true }) },
    onNew: async (r) => seen.push(r.id),
    intervalMs: 10_000,
  });
  const fresh = await poller.tick();
  assert.deepEqual(fresh, []);
  assert.deepEqual(seen, []);
});

test("start polls immediately and stop ends the timer", async () => {
  let calls = 0;
  const poller = createPoller({
    source: {
      list: async () => {
        calls++;
        return [];
      },
    },
    onNew: async () => {},
    intervalMs: 20,
  });
  await poller.start();
  assert.equal(calls, 1);
  poller.stop();
  await sleeping(60);
  assert.equal(calls, 1);
  poller.stop();
});

test("overlapping ticks share one source call", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const poller = createPoller({
    source: {
      list: async () => {
        calls++;
        await gate;
        return [];
      },
    },
    onNew: async () => {},
    intervalMs: 10_000,
  });
  const first = poller.tick();
  const second = poller.tick();
  assert.equal(first, second);
  release();
  await first;
  assert.equal(calls, 1);
});

test("a failing handler is logged and later requests still notify", async () => {
  const errors = [];
  const seen = [];
  const poller = createPoller({
    source: { list: async () => [{ id: "per_1" }, { id: "per_2" }] },
    onNew: async (r) => {
      if (r.id === "per_1") throw new Error("boom");
      seen.push(r.id);
    },
    intervalMs: 10_000,
    log: { error: (...args) => errors.push(args) },
  });
  await poller.tick();
  assert.deepEqual(seen, ["per_2"]);
  assert.equal(errors.length, 1);
});

test("rejects a poller without a usable source or handler", () => {
  assert.throws(() => createPoller({ onNew: async () => {} }), /source\.list/);
  assert.throws(
    () => createPoller({ source: { list: async () => [] } }),
    /onNew/,
  );
  assert.throws(
    () =>
      createPoller({
        source: { list: async () => [] },
        onNew: async () => {},
        intervalMs: 0,
      }),
    /intervalMs/,
  );
});
