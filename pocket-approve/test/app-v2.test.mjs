import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createAppV2 } from "../lib/app-v2.mjs";

function makeApp(overrides = {}) {
  const events = { added: [], removed: [], tests: [], replies: [] };
  const config = {
    mode: "proxy",
    host: "127.0.0.1",
    httpPort: 8080,
    publicOrigin: "https://approve.example.com",
    allowLegacyToken: false,
    token: null,
    vapid: { publicKey: "public-key", privateKey: "private-key", subject: "mailto:a@example.com" },
    servers: [{ id: "local", label: "Laptop", url: "http://127.0.0.1:4096" }],
  };
  const device = { id: "dev_abc", name: "Phone", scopes: ["read", "approve"] };
  const fleet = {
    pending: () => ({
      requests: [{
        id: "local:per_1",
        serverId: "local",
        serverLabel: "Laptop",
        sessionID: "ses_1",
        permission: "bash",
        patterns: ["git status"],
        always: [],
        tool: "bash",
        metadata: { command: "git status" },
        title: "Bash: git status",
        summary: "git status",
        firstSeen: "2026-10-25T12:00:00.000Z",
      }],
      servers: [{ id: "local", label: "Laptop", ok: true, pending: 1 }],
      fetchedAt: "2026-10-25T12:00:01.000Z",
    }),
    servers: () => [{ id: "local", label: "Laptop", ok: true, pending: 1 }],
    reply: async (id, decision) => {
      events.replies.push({ id, decision });
      if (id === "local:missing") return { status: 404, error: "unknown_request" };
      if (id === "local:upstream401") return { status: 502, error: "server_unauthorized" };
      return { status: 200 };
    },
  };
  const ownedSubscriptions = [];
  const push = {
    publicKey: "public-key",
    add: async (subscription, deviceId) => {
      events.added.push({ subscription, deviceId });
      const index = ownedSubscriptions.findIndex(
        (item) => item.endpoint === subscription.endpoint,
      );
      if (index === -1) ownedSubscriptions.push(subscription);
      else ownedSubscriptions[index] = subscription;
    },
    listForDevice: () => ownedSubscriptions.map((item) => ({ ...item })),
    remove: async (endpoint) => {
      const index = ownedSubscriptions.findIndex((item) => item.endpoint === endpoint);
      if (index === -1) return false;
      ownedSubscriptions.splice(index, 1);
      events.removed.push(endpoint);
      return true;
    },
  };
  const pairing = {
    redeem: async (code, handler) => {
      if (code !== "ABCD-EFGH") return { ok: false, reason: "bad_code" };
      await handler({ label: "Phone label" });
      return { ok: true, label: "Phone label" };
    },
  };
  const devices = {
    findActive: async (token) => token === "good" ? device : token === "revoked" ? null : null,
    touch: async () => {},
    create: async (name) => ({ device: { ...device, name }, token: "new-device-token" }),
  };
  const notifications = {
    sendTest: async (deviceId) => { events.tests.push(deviceId); return { sent: 1, failed: 0, pruned: 0 }; },
  };
  const audit = { append: async () => {} };
  const app = createAppV2({
    config,
    fleet,
    push,
    pairing,
    devices,
    notifications,
    audit,
    dataDir: new URL("../public", import.meta.url).pathname,
    ...overrides,
  });
  return { app, events, device };
}

async function call(app, path, { method = "GET", token = "good", body, origin, headers = {} } = {}) {
  const effectiveOrigin = origin === undefined && method === "POST"
    ? "https://approve.example.com"
    : origin;
  const request = new Request(`https://approve.example.com${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(effectiveOrigin ? { origin: effectiveOrigin } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await app.handler(request);
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  return { response, body: payload, text };
}

test("health is public and carries v2 headers", async () => {
  const { app } = makeApp();
  const { response, body } = await call(app, "/api/health", { token: null });
  assert.equal(response.status, 200);
  assert.equal(body.version, "2.0.0");
  assert.equal(body.mode, "proxy");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
});

test("pending and servers require a device and return the object shape", async () => {
  const { app } = makeApp();
  const denied = await call(app, "/api/pending", { token: null });
  assert.equal(denied.response.status, 401);
  const pending = await call(app, "/api/pending");
  assert.equal(pending.response.status, 200);
  assert.equal(pending.body.requests[0].id, "local:per_1");
  assert.equal(pending.body.requests[0].serverLabel, "Laptop");
  assert.deepEqual(pending.body.servers, [{ id: "local", label: "Laptop", ok: true, pending: 1 }]);
  const servers = await call(app, "/api/servers");
  assert.deepEqual(servers.body, { servers: [{ id: "local", label: "Laptop", ok: true, pending: 1 }] });
});

test("pair creates a device, clears the code, and returns the token once", async () => {
  const { app, events } = makeApp();
  const ok = await call(app, "/api/pair", {
    method: "POST",
    token: null,
    body: { code: "ABCD-EFGH", deviceName: "Phone" },
    origin: "https://approve.example.com",
  });
  assert.equal(ok.response.status, 201);
  assert.equal(ok.body.token, "new-device-token");
  assert.equal(ok.body.origin, "https://approve.example.com");
  assert.equal(ok.body.device.id, "dev_abc");
  assert.equal(JSON.stringify(ok.body).includes("password"), false);
  const bad = await call(app, "/api/pair", {
    method: "POST",
    token: null,
    body: { code: "ZZZZ-ZZZZ", deviceName: "Phone" },
    origin: "https://approve.example.com",
  });
  assert.equal(bad.response.status, 401);
  assert.equal(events.added.length, 0);
});

test("a device write failure returns 500 and leaves the code usable", async () => {
  let attempts = 0;
  const device = { id: "dev_abc", name: "Phone", scopes: ["read", "approve"] };
  const { app } = makeApp({
    devices: {
      findActive: async () => null,
      touch: async () => {},
      list: () => [],
      activeCount: () => 0,
      create: async (name) => {
        attempts += 1;
        if (attempts === 1) throw new Error("disk full");
        return { device: { ...device, name }, token: "new-device-token" };
      },
    },
  });
  const failed = await call(app, "/api/pair", {
    method: "POST",
    token: null,
    body: { code: "ABCD-EFGH", deviceName: "Phone" },
    origin: "https://approve.example.com",
  });
  assert.equal(failed.response.status, 500);
  assert.equal(failed.body.error, "pair_failed");
  const retried = await call(app, "/api/pair", {
    method: "POST",
    token: null,
    body: { code: "ABCD-EFGH", deviceName: "Phone" },
    origin: "https://approve.example.com",
  });
  assert.equal(retried.response.status, 201);
  assert.equal(retried.body.token, "new-device-token");
});

test("reply statuses are strict and audit only the request metadata", async () => {
  const seen = [];
  const { app, events } = makeApp({ audit: { append: async (action, fields) => seen.push({ action, fields }) } });
  const ok = await call(app, "/api/reply", { method: "POST", body: { id: "local:per_1", decision: "once" } });
  assert.equal(ok.response.status, 200);
  assert.deepEqual(events.replies[0], { id: "local:per_1", decision: "once" });
  assert.equal(seen[0].action, "reply");
  assert.equal(seen[0].fields.requestId, "local:per_1");
  assert.equal(JSON.stringify(seen).includes("git status"), false);
  const missing = await call(app, "/api/reply", { method: "POST", body: { id: "local:missing", decision: "once" } });
  assert.equal(missing.response.status, 404);
  const upstream = await call(app, "/api/reply", { method: "POST", body: { id: "local:upstream401", decision: "once" } });
  assert.equal(upstream.response.status, 502);
  assert.equal(upstream.body.error, "server_unauthorized");
  const invalid = await call(app, "/api/reply", { method: "POST", body: { id: "local:per_1", decision: "yes" } });
  assert.equal(invalid.response.status, 400);
});

test("subscribe is device-owned and unsubscribe only removes the caller's endpoint", async () => {
  const { app, events } = makeApp();
  const subscription = {
    endpoint: "https://push.example/own",
    expirationTime: null,
    keys: { p256dh: "p", auth: "a" },
  };
  const subscribed = await call(app, "/api/subscribe", {
    method: "POST",
    body: { subscription },
    origin: "https://approve.example.com",
  });
  assert.equal(subscribed.response.status, 201);
  assert.equal(subscribed.body.subscriptions, 1);
  assert.equal(events.added[0].deviceId, "dev_abc");
  assert.equal(events.added[0].subscription.endpoint, subscription.endpoint);

  const repeated = await call(app, "/api/subscribe", {
    method: "POST",
    body: { subscription },
    origin: "https://approve.example.com",
  });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.subscriptions, 1);

  const removed = await call(app, "/api/unsubscribe", {
    method: "POST",
    body: { endpoint: "https://push.example/own" },
    origin: "https://approve.example.com",
  });
  assert.equal(removed.response.status, 204);
  assert.deepEqual(events.removed, ["https://push.example/own"]);

  const foreign = await call(app, "/api/unsubscribe", {
    method: "POST",
    body: { endpoint: "https://push.example/other" },
    origin: "https://approve.example.com",
  });
  assert.equal(foreign.response.status, 404);
});

test("origin, body size, methods, unknown paths, and test notifications are constrained", async () => {
  const { app, events } = makeApp();
  const csrf = await call(app, "/api/reply", {
    method: "POST",
    body: { id: "local:per_1", decision: "once" },
    origin: "https://evil.example.com",
  });
  assert.equal(csrf.response.status, 403);
  const noOrigin = await call(app, "/api/reply", {
    method: "POST",
    body: { id: "local:per_1", decision: "once" },
    origin: null,
  });
  assert.equal(noOrigin.response.status, 403);
  const large = await call(app, "/api/reply", {
    method: "POST",
    body: { id: "x".repeat(17_000), decision: "once" },
  });
  assert.equal(large.response.status, 413);
  const method = await call(app, "/api/pending", { method: "DELETE" });
  assert.equal(method.response.status, 405);
  assert.equal(method.response.headers.get("allow"), "GET");
  const healthMethod = await call(app, "/api/health", { method: "POST", token: null, body: {} });
  assert.equal(healthMethod.response.status, 405);
  assert.equal(healthMethod.response.headers.get("allow"), "GET");
  const unknown = await call(app, "/api/nope");
  assert.equal(unknown.response.status, 404);
  const test = await call(app, "/api/test-notification", {
    method: "POST",
    body: {},
    origin: "https://approve.example.com",
  });
  assert.equal(test.response.status, 200);
  assert.deepEqual(test.body, { sent: 1, failed: 0, pruned: 0 });
  assert.deepEqual(events.tests, ["dev_abc"]);
});

test("static /pair is public and the service worker is not cached", async () => {
  const { app } = makeApp();
  const pair = await call(app, "/pair", { token: null });
  assert.equal(pair.response.status, 200);
  assert.match(pair.text, /Pocket Approve/);
  const head = await call(app, "/", { method: "HEAD", token: null });
  assert.equal(head.response.status, 200);
  const worker = await call(app, "/sw.js", { token: null });
  assert.equal(worker.response.status, 200);
  assert.equal(worker.response.headers.get("cache-control"), "no-cache");
  assert.equal(worker.response.headers.get("service-worker-allowed"), "/");
  const dot = await call(app, "/.env", { token: null });
  assert.equal(dot.response.status, 404);
});
