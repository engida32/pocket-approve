import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import { createPush } from "../lib/push.mjs";

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pa-push-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function vapid() {
  return { subject: "mailto:a@b.c", ...webpush.generateVAPIDKeys() };
}

function recorder(handler) {
  const calls = [];
  const sendFn = async (sub, payload, options) => {
    calls.push({ sub, payload, options });
    if (handler) return handler(sub, payload, options);
  };
  return { calls, sendFn };
}

function quietLog() {
  const errors = [];
  return { errors, log: { error: (...args) => errors.push(args) } };
}

test("dedupes subscriptions and prunes on 410", async (t) => {
  const dir = await tempDir(t);
  const sent = [];
  const push = createPush({
    dataDir: dir,
    vapid: vapid(),
    sendFn: async (sub) => {
      sent.push(sub.endpoint);
      const error = new Error("gone");
      error.statusCode = 410;
      throw error;
    },
  });
  await push.init();
  await push.add({ endpoint: "https://push/1" });
  await push.add({ endpoint: "https://push/1" });
  assert.equal(push.list().length, 1);
  await push.send({ requestId: "per_1" });
  assert.equal(push.list().length, 0);
  assert.deepEqual(sent, ["https://push/1"]);
});

test("persists subscriptions across a reopen", async (t) => {
  const dir = await tempDir(t);
  const first = createPush({ dataDir: dir, vapid: vapid(), sendFn: async () => {} });
  await first.init();
  await first.add({ endpoint: "https://push/1" });
  await first.add({ endpoint: "https://push/2", keys: { p256dh: "p", auth: "a" } });

  const second = createPush({ dataDir: dir, vapid: vapid(), sendFn: async () => {} });
  await second.init();
  assert.deepEqual(
    second.list().map((sub) => sub.endpoint),
    ["https://push/1", "https://push/2"],
  );
  assert.deepEqual(second.list()[1].keys, { p256dh: "p", auth: "a" });

  assert.equal(await second.remove("https://push/1"), true);
  assert.equal(await second.remove("https://push/1"), false);

  const third = createPush({ dataDir: dir, vapid: vapid(), sendFn: async () => {} });
  await third.init();
  assert.deepEqual(third.list().map((sub) => sub.endpoint), ["https://push/2"]);
});

test("writes subscriptions.json with mode 0600", async (t) => {
  const dir = await tempDir(t);
  const push = createPush({ dataDir: dir, vapid: vapid(), sendFn: async () => {} });
  await push.init();
  await push.add({ endpoint: "https://push/1" });
  const file = join(dir, "subscriptions.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(Array.isArray(JSON.parse(await readFile(file, "utf8"))));
});

test("tightens an existing store to mode 0600", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, "subscriptions.json");
  await writeFile(file, JSON.stringify([{ endpoint: "https://push/1" }]), { mode: 0o644 });
  const push = createPush({ dataDir: dir, vapid: vapid(), sendFn: async () => {} });
  await push.init();
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("duplicate add merges keys and invalid subscriptions are rejected", async (t) => {
  const dir = await tempDir(t);
  const push = createPush({ dataDir: dir, vapid: vapid(), sendFn: async () => {} });
  await push.init();
  await push.add({ endpoint: "https://push/1", keys: { p256dh: "p", auth: "old" } });
  await push.add({ endpoint: "https://push/1", keys: { auth: "new" } });
  assert.equal(push.list().length, 1);
  assert.deepEqual(push.list()[0].keys, { p256dh: "p", auth: "new" });

  for (const invalid of [
    null,
    {},
    { endpoint: "" },
    { endpoint: 42 },
    { endpoint: "not a url" },
    { endpoint: "https://push/2", keys: "nope" },
    { endpoint: "https://push/2", keys: { auth: 42 } },
  ]) {
    await assert.rejects(push.add(invalid), TypeError);
  }
  assert.equal(push.list().length, 1);
});

test("send fans out the payload to every subscription", async (t) => {
  const dir = await tempDir(t);
  const details = vapid();
  const { calls, sendFn } = recorder();
  const push = createPush({ dataDir: dir, vapid: details, sendFn });
  await push.init();
  await push.add({ endpoint: "https://push/1" });
  await push.add({ endpoint: "https://push/2" });

  const payload = { requestId: "per_1", title: "OpenCode", summary: "Allow bash?" };
  const result = await push.send(payload);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.sub.endpoint), ["https://push/1", "https://push/2"]);
  for (const call of calls) {
    assert.deepEqual(JSON.parse(call.payload), payload);
    assert.deepEqual(call.options.vapidDetails, {
      subject: details.subject,
      publicKey: details.publicKey,
      privateKey: details.privateKey,
    });
  }
  assert.deepEqual(result, { sent: 2, failed: 0, removed: 0 });
});

test("one failing endpoint does not block the rest", async (t) => {
  const dir = await tempDir(t);
  const { errors, log } = quietLog();
  const { calls, sendFn } = recorder((sub) => {
    if (sub.endpoint === "https://push/2") {
      const error = new Error("server error");
      error.statusCode = 500;
      throw error;
    }
  });
  const push = createPush({ dataDir: dir, vapid: vapid(), sendFn, log });
  await push.init();
  await push.add({ endpoint: "https://push/1" });
  await push.add({ endpoint: "https://push/2" });
  await push.add({ endpoint: "https://push/3" });

  const result = await push.send({ requestId: "per_1" });

  assert.deepEqual(calls.map((call) => call.sub.endpoint), [
    "https://push/1",
    "https://push/2",
    "https://push/3",
  ]);
  assert.deepEqual(result, { sent: 2, failed: 1, removed: 0 });
  assert.equal(push.list().length, 3);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /https:\/\/push\/2/);
});

test("send removes only 404 and 410 endpoints", async (t) => {
  const dir = await tempDir(t);
  const { errors, log } = quietLog();
  const sendFn = async (sub) => {
    if (sub.endpoint === "https://push/gone") {
      const error = new Error("gone");
      error.statusCode = 410;
      throw error;
    }
    if (sub.endpoint === "https://push/missing") {
      const error = new Error("missing");
      error.statusCode = 404;
      throw error;
    }
    if (sub.endpoint === "https://push/broken") {
      const error = new Error("broken");
      error.statusCode = 503;
      throw error;
    }
  };
  const push = createPush({ dataDir: dir, vapid: vapid(), sendFn, log });
  await push.init();
  for (const endpoint of [
    "https://push/ok",
    "https://push/gone",
    "https://push/missing",
    "https://push/broken",
  ]) {
    await push.add({ endpoint });
  }

  const result = await push.send({ requestId: "per_1" });

  assert.deepEqual(result, { sent: 1, failed: 1, removed: 2 });
  assert.deepEqual(push.list().map((sub) => sub.endpoint), ["https://push/ok", "https://push/broken"]);
  assert.equal(errors.length, 1);

  const reopened = createPush({ dataDir: dir, vapid: vapid(), sendFn: async () => {} });
  await reopened.init();
  assert.deepEqual(reopened.list().map((sub) => sub.endpoint), ["https://push/ok", "https://push/broken"]);
});

test("init rejects a corrupt store", async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "subscriptions.json"), "{not json", { mode: 0o600 });
  const push = createPush({ dataDir: dir, vapid: vapid(), sendFn: async () => {} });
  await assert.rejects(push.init(), /Invalid JSON/);
});

test("exposes the VAPID public key", async () => {
  const details = vapid();
  const push = createPush({ dataDir: "/tmp/unused", vapid: details, sendFn: async () => {} });
  assert.equal(push.publicKey, details.publicKey);
});
