import test from "node:test";
import assert from "node:assert/strict";
import { createNotifications } from "../lib/notifications.mjs";
import { buildNotifyArgs } from "../lib/desktop.mjs";

function request(id, extra = {}) {
  return {
    id: `alpha:${id}`,
    serverId: "alpha",
    serverLabel: "Alpha",
    sessionID: "ses_1",
    permission: "bash",
    patterns: ["x"],
    always: [],
    tool: "bash",
    metadata: {},
    title: "Bash: " + "t".repeat(200),
    summary: "s".repeat(300),
    firstSeen: "2026-10-25T12:00:00.000Z",
    ...extra,
  };
}

function harness(items) {
  const pushed = [];
  const desktop = [];
  const replies = [];
  const seen = new Map();
  return {
    pushed,
    desktop,
    replies,
    dependencies: {
      fleet: {
        pending: () => ({ requests: items, servers: [], fetchedAt: "2026-10-25T12:00:00.000Z" }),
        reply: async (id, decision) => { replies.push({ id, decision }); return { status: 200 }; },
      },
      seen: {
        takeNew: async (fresh) => fresh.filter((item) => !seen.has(item.id) && seen.set(item.id, 1)),
        observe: async () => {},
      },
      push: {
        send: async (payload, options) => { pushed.push({ payload, options }); return { sent: 1, failed: 0, removed: 0 }; },
        listForDevice: () => [],
      },
      devices: { list: () => [{ id: "dev_1", revokedAt: null }] },
      desktop: {
        notify: async (item) => { desktop.push(item); return item.id.endsWith(":2") ? { decision: "reject" } : null; },
      },
      audit: { append: async () => {} },
    },
  };
}

test("new requests are announced once, capped, and routed on desktop action", async () => {
  const h = harness([request("1"), request("2")]);
  const notifications = createNotifications(h.dependencies);
  const first = await notifications.announce({ id: "alpha" });
  const second = await notifications.announce({ id: "alpha" });
  assert.equal(first.desktop, 2);
  assert.equal(first.pushes, 1);
  assert.equal(second.desktop, 0);
  assert.equal(second.pushes, 0);
  assert.equal(h.pushed.length, 1);
  const { payload, options } = h.pushed[0];
  assert.equal(payload.kind, "request");
  assert.equal(payload.serverLabel, "Alpha");
  assert.equal(payload.title.length, 64);
  assert.equal(payload.summary.length, 140);
  assert.equal(options.deviceId, "dev_1");
  assert.equal(options.options.TTL, 600);
  assert.equal(options.options.urgency, "high");
  assert.equal(options.options.topic.length <= 32, true);
  assert.equal(Buffer.byteLength(JSON.stringify(payload)) < 3584, true);
  assert.deepEqual(h.replies, [{ id: "alpha:2", decision: "reject" }]);
});

test("more than ten new requests in one poll become one digest", async () => {
  const items = Array.from({ length: 11 }, (_, index) => request(String(index)));
  const h = harness(items);
  const notifications = createNotifications(h.dependencies);
  const result = await notifications.announce({ id: "alpha" });
  assert.equal(result.digest, true);
  assert.equal(result.desktop, 1);
  assert.equal(result.pushes, 1);
  assert.equal(h.pushed[0].payload.kind, "digest");
  assert.equal(h.pushed[0].payload.count, 11);
  assert.equal(h.desktop[0].actions, false);
});

test("a desktop notification can be built without approval actions", () => {
  const withActions = buildNotifyArgs({ title: "Bash", summary: "ls" });
  const withoutActions = buildNotifyArgs({ title: "Alpha: 11 new requests", summary: "Open Pocket Approve.", actions: false });
  assert.equal(withActions.at(-3), "['once', 'Allow once', 'reject', 'Deny', 'always', 'Allow always']");
  assert.equal(withoutActions.at(-3), "[]");
});

test("test notifications belong to one device and never send a reply", async () => {
  const h = harness([]);
  const notifications = createNotifications(h.dependencies);
  const result = await notifications.sendTest("dev_1");
  assert.deepEqual(result, { sent: 1, failed: 0, pruned: 0 });
  assert.equal(h.pushed[0].payload.kind, "test");
  assert.match(h.pushed[0].payload.id, /^test:/);
  assert.deepEqual(h.replies, []);
});

test("shrink terminates when non-summary fields alone exceed the byte cap", () => {
  const h = harness([]);
  const notifications = createNotifications(h.dependencies);
  const oversized = {
    id: "alpha:" + "x".repeat(4096),
    serverId: "alpha",
    serverLabel: "Alpha",
    title: "t",
    summary: "abc",
    count: 1,
    kind: "request",
  };
  const shrunk = notifications.shrinkPayload(oversized);
  assert.equal(shrunk.summary, "");
  assert.equal(shrunk.id, oversized.id);
  assert.equal(Buffer.byteLength(JSON.stringify(shrunk)) > 3584, true);
});

test("announce only reports requests for the link's server", async () => {
  const alpha = request("1");
  const beta = request("9", { id: "beta:9", serverId: "beta", serverLabel: "Beta" });
  const h = harness([alpha, beta]);
  const notifications = createNotifications(h.dependencies);
  const first = await notifications.announce({ id: "alpha" });
  assert.equal(first.desktop, 1);
  assert.equal(first.pushes, 1);
  assert.equal(h.pushed[0].payload.serverId, "alpha");
  const second = await notifications.announce({ id: "beta", label: "Beta" });
  assert.equal(second.desktop, 1);
  assert.equal(h.pushed.at(-1).payload.serverId, "beta");
});

test("ten new requests stay individual requests, not a digest", async () => {
  const items = Array.from({ length: 10 }, (_, index) => request(String(index)));
  const h = harness(items);
  const notifications = createNotifications(h.dependencies);
  const result = await notifications.announce({ id: "alpha" });
  assert.equal(result.digest, false);
  assert.equal(result.desktop, 10);
  assert.equal(result.pushes, 1);
  assert.equal(h.pushed[0].payload.kind, "request");
});

test("desktop once and always decisions are routed through fleet.reply", async () => {
  const h = harness([request("1"), request("2")]);
  h.dependencies.desktop.notify = async (item) => {
    h.desktop.push(item);
    return { decision: item.id.endsWith(":1") ? "once" : "always" };
  };
  const notifications = createNotifications(h.dependencies);
  const result = await notifications.announce({ id: "alpha" });
  assert.equal(result.desktop, 2);
  assert.deepEqual(h.replies, [
    { id: "alpha:1", decision: "once" },
    { id: "alpha:2", decision: "always" },
  ]);
});

test("a test with no device uses the unowned legacy path", async () => {
  const h = harness([]);
  h.dependencies.push.listForDevice = () => [{ endpoint: "https://example.test/push" }];
  const notifications = createNotifications(h.dependencies);
  const result = await notifications.sendTest(null);
  assert.deepEqual(result, { sent: 1, failed: 0, pruned: 0 });
  assert.equal(h.pushed[0].options.deviceId, null);
  assert.deepEqual(h.replies, []);
});
