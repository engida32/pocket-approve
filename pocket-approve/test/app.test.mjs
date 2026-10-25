import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createApp } from "../lib/app.mjs";
import { tokensEqual } from "../lib/auth.mjs";
import { readTls } from "../lib/tls.mjs";

const run = promisify(execFile);

function fakeSource(requests = []) {
  const replies = [];
  return {
    replies,
    list: async () => requests,
    reply: async (id, decision) => {
      replies.push([id, decision]);
    },
  };
}

function fakePush() {
  const added = [];
  const sent = [];
  return {
    added,
    sent,
    publicKey: "pub",
    add: async (subscription) => {
      added.push(subscription);
    },
    send: async (payload) => {
      sent.push(payload);
      return { sent: 1, failed: 0, removed: 0 };
    },
  };
}

function fakeDesktop() {
  const closed = [];
  return {
    closed,
    notify: async () => ({ id: 1 }),
    close: (id) => {
      closed.push(id);
    },
  };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
  };
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pa-app-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

function jsonPost(base, token, path, body) {
  return fetch(base + path, {
    method: "POST",
    headers: {
      ...auth(token),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("rejects a bad token and accepts the first reply", async () => {
  const requests = [
    {
      id: "per_1",
      sessionID: "ses_1",
      permission: "bash",
      patterns: ["x"],
      metadata: {},
      title: "T",
      summary: "S",
    },
  ];
  const fakeSrc = fakeSource(requests);
  const app = createApp({
    source: fakeSrc,
    push: fakePush(),
    desktop: fakeDesktop(),
    config: { token: "good" },
  });
  const { server, base } = await listen(app.handler);
  try {
    assert.equal((await fetch(base + "/api/pending")).status, 401);
    assert.equal(
      (await fetch(base + "/api/pending", { headers: auth("good") })).status,
      200,
    );
    const post = (body) => jsonPost(base, "good", "/api/reply", body);
    assert.equal((await post({ id: "per_1", decision: "once" })).status, 200);
    assert.equal((await post({ id: "per_1", decision: "reject" })).status, 404);
    assert.deepEqual(fakeSrc.replies, [["per_1", "once"]]);
  } finally {
    await close(server);
  }
});

test("the first concurrent reply wins and the second gets 404", async () => {
  const fakeSrc = fakeSource([{ id: "per_1", title: "T", summary: "S" }]);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const replyStarted = new Promise((resolve) => {
    started = resolve;
  });
  const originalReply = fakeSrc.reply;
  fakeSrc.reply = async (id, decision) => {
    started();
    await gate;
    return originalReply(id, decision);
  };

  const app = createApp({
    source: fakeSrc,
    push: fakePush(),
    desktop: fakeDesktop(),
    config: { token: "good" },
  });
  const { server, base } = await listen(app.handler);
  try {
    await fetch(base + "/api/pending", { headers: auth("good") });
    const first = jsonPost(base, "good", "/api/reply", {
      id: "per_1",
      decision: "once",
    });
    await replyStarted;
    const relisted = await fetch(base + "/api/pending", { headers: auth("good") });
    assert.equal(relisted.status, 200);
    assert.deepEqual(await relisted.json(), []);
    const second = await jsonPost(base, "good", "/api/reply", {
      id: "per_1",
      decision: "reject",
    });
    assert.equal(second.status, 404);
    release();
    assert.equal((await first).status, 200);
    assert.deepEqual(fakeSrc.replies.length, 1);
  } finally {
    await close(server);
  }
});

test("reply works before the page has listed pending requests", async () => {
  const fakeSrc = fakeSource([{ id: "per_1", title: "T", summary: "S" }]);
  const app = createApp({
    source: fakeSrc,
    push: fakePush(),
    desktop: fakeDesktop(),
    config: { token: "good" },
  });
  const { server, base } = await listen(app.handler);
  try {
    const reply = await jsonPost(base, "good", "/api/reply", {
      id: "per_1",
      decision: "once",
    });
    assert.equal(reply.status, 200);
    assert.deepEqual(fakeSrc.replies, [["per_1", "once"]]);
  } finally {
    await close(server);
  }
});

test("unknown ids and invalid decisions are rejected without replying", async () => {
  const fakeSrc = fakeSource([{ id: "per_1", title: "T", summary: "S" }]);
  const desktop = fakeDesktop();
  const app = createApp({
    source: fakeSrc,
    push: fakePush(),
    desktop,
    config: { token: "good" },
  });
  const { server, base } = await listen(app.handler);
  try {
    await fetch(base + "/api/pending", { headers: auth("good") });
    assert.equal(
      (
        await jsonPost(base, "good", "/api/reply", {
          id: "missing",
          decision: "once",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await jsonPost(base, "good", "/api/reply", {
          id: "per_1",
          decision: "maybe",
        })
      ).status,
      400,
    );
    assert.equal(
      (await jsonPost(base, "good", "/api/reply", { decision: "once" })).status,
      400,
    );
    assert.deepEqual(fakeSrc.replies, []);
    assert.deepEqual(desktop.closed, []);
  } finally {
    await close(server);
  }
});

test("a source failure returns 502 and the phone can retry", async () => {
  const fakeSrc = fakeSource([{ id: "per_1", title: "T", summary: "S" }]);
  const originalReply = fakeSrc.reply;
  let attempts = 0;
  fakeSrc.reply = async (id, decision) => {
    attempts += 1;
    if (attempts === 1) throw new Error("opencode down");
    return originalReply(id, decision);
  };
  const desktop = fakeDesktop();
  const app = createApp({
    source: fakeSrc,
    push: fakePush(),
    desktop,
    config: { token: "good" },
  });
  const { server, base } = await listen(app.handler);
  try {
    await fetch(base + "/api/pending", { headers: auth("good") });
    const first = await jsonPost(base, "good", "/api/reply", {
      id: "per_1",
      decision: "once",
    });
    assert.equal(first.status, 502);
    assert.deepEqual(desktop.closed, []);
    const second = await jsonPost(base, "good", "/api/reply", {
      id: "per_1",
      decision: "once",
    });
    assert.equal(second.status, 200);
    assert.equal(attempts, 2);
    assert.deepEqual(fakeSrc.replies, [["per_1", "once"]]);
    assert.deepEqual(desktop.closed, ["per_1"]);
  } finally {
    await close(server);
  }
});

test("an upstream 404 is surfaced as 404, not 502", async () => {
  const fakeSrc = fakeSource([{ id: "per_1", title: "T", summary: "S" }]);
  fakeSrc.reply = async () => {
    const error = new Error("gone");
    error.status = 404;
    throw error;
  };
  const app = createApp({
    source: fakeSrc,
    push: fakePush(),
    desktop: fakeDesktop(),
    config: { token: "good" },
  });
  const { server, base } = await listen(app.handler);
  try {
    await fetch(base + "/api/pending", { headers: auth("good") });
    const reply = await jsonPost(base, "good", "/api/reply", {
      id: "per_1",
      decision: "once",
    });
    assert.equal(reply.status, 404);
  } finally {
    await close(server);
  }
});

test("successful reply closes the desktop notification", async () => {
  const fakeSrc = fakeSource([{ id: "per_1", title: "T", summary: "S" }]);
  const desktop = fakeDesktop();
  const app = createApp({
    source: fakeSrc,
    push: fakePush(),
    desktop,
    config: { token: "good" },
  });
  const { server, base } = await listen(app.handler);
  try {
    await fetch(base + "/api/pending", { headers: auth("good") });
    const reply = await jsonPost(base, "good", "/api/reply", {
      id: "per_1",
      decision: "always",
    });
    assert.equal(reply.status, 200);
    assert.deepEqual(desktop.closed, ["per_1"]);
  } finally {
    await close(server);
  }
});

test("health is public and APIs send no-store and security headers", async () => {
  const app = createApp({
    source: fakeSource(),
    push: fakePush(),
    desktop: fakeDesktop(),
    config: { token: "good" },
  });
  const { server, base } = await listen(app.handler);
  try {
    const health = await fetch(base + "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.equal(health.headers.get("x-frame-options"), "DENY");
    assert.equal(health.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(await health.json(), { ok: true });

    const denied = await fetch(base + "/api/pending");
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("cache-control"), "no-store");
  } finally {
    await close(server);
  }
});

test("serves the VAPID key, subscriptions, and a test notification", async () => {
  const push = fakePush();
  const app = createApp({
    source: fakeSource(),
    push,
    desktop: fakeDesktop(),
    config: { token: "good" },
  });
  const { server, base } = await listen(app.handler);
  try {
    const key = await fetch(base + "/api/vapid-public-key", {
      headers: auth("good"),
    });
    assert.equal(key.status, 200);
    assert.deepEqual(await key.json(), { publicKey: "pub" });

    const subscription = {
      endpoint: "https://push.example/1",
      keys: { p256dh: "p", auth: "a" },
    };
    const subscribe = await jsonPost(
      base,
      "good",
      "/api/subscribe",
      subscription,
    );
    assert.equal(subscribe.status, 201);
    assert.deepEqual(push.added, [subscription]);

    const missing = await fetch(base + "/api/vapid-public-key");
    assert.equal(missing.status, 401);

    const testNotification = await jsonPost(
      base,
      "good",
      "/api/test-notification",
      {},
    );
    assert.equal(testNotification.status, 200);
    assert.equal(push.sent.length, 1);
    assert.equal(push.sent[0].requestId, "test");
    assert.equal(typeof push.sent[0].title, "string");
  } finally {
    await close(server);
  }
});

test("rejects malformed JSON, methods, and oversized bodies", async () => {
  const app = createApp({
    source: fakeSource([{ id: "per_1" }]),
    push: fakePush(),
    desktop: fakeDesktop(),
    config: { token: "good" },
  });
  const { server, base } = await listen(app.handler);
  try {
    const malformed = await fetch(base + "/api/reply", {
      method: "POST",
      headers: { ...auth("good"), "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);

    const wrongMethod = await fetch(base + "/api/reply", {
      headers: auth("good"),
    });
    assert.equal(wrongMethod.status, 405);

    const oversized = await fetch(base + "/api/reply", {
      method: "POST",
      headers: { ...auth("good"), "content-type": "application/json" },
      body: JSON.stringify({ id: "x".repeat(70 * 1024), decision: "once" }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await close(server);
  }
});

test("never serves traversal paths or the config through the API", async () => {
  const app = createApp({
    source: fakeSource(),
    push: fakePush(),
    desktop: fakeDesktop(),
    config: { token: "good" },
  });
  const { server, base } = await listen(app.handler);
  try {
    for (const path of [
      "/../data/config.json",
      "/data/config.json",
      "/%2e%2e/data/config.json",
    ]) {
      const response = await fetch(base + path, { headers: auth("good") });
      assert.equal(response.status, 404, path);
    }
  } finally {
    await close(server);
  }
});

test("the setup server serves only the CA and a token-free page", async (t) => {
  const dir = await tempDir(t);
  const pem = "-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----\n";
  await writeFile(join(dir, "ca.crt"), pem);
  await writeFile(join(dir, "config.json"), JSON.stringify({ token: "secret" }));

  const app = createApp({
    source: fakeSource(),
    push: fakePush(),
    desktop: fakeDesktop(),
    config: { token: "secret", dataDir: dir },
  });
  const { server, base } = await listen(app.setupHandler);
  try {
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Pocket Approve/);
    assert.match(html, /ca\.crt/);
    assert.ok(!html.includes("secret"));
    assert.ok(!html.includes("/api/reply"));

    const cert = await fetch(base + "/ca.crt");
    assert.equal(cert.status, 200);
    assert.equal(
      cert.headers.get("content-type"),
      "application/x-x509-ca-cert",
    );
    assert.equal(await cert.text(), pem);

    for (const path of ["/config.json", "/data/config.json", "/../data/config.json"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 404, path);
    }
  } finally {
    await close(server);
  }
});


function httpsGet(port, path, ca, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      { hostname: "127.0.0.1", port, path, method: "GET", ca, headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("the HTTPS listener enforces the bearer token with a trusted CA", async (t) => {
  const dir = await tempDir(t);
  await run(
    process.execPath,
    ["scripts/setup.mjs", "--host", "127.0.0.1", "--no-qr"],
    { env: { ...process.env, POCKET_APPROVE_DATA: dir } },
  );
  const tls = await readTls(dir);
  const ca = await readFile(join(dir, "ca.crt"));
  const app = createApp({
    source: fakeSource(),
    push: fakePush(),
    desktop: fakeDesktop(),
    config: { token: "good", dataDir: dir },
  });
  const server = https.createServer(tls, app.handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = server.address().port;
    const denied = await httpsGet(port, "/api/pending", ca);
    assert.equal(denied.status, 401);
    const allowed = await httpsGet(port, "/api/pending", ca, auth("good"));
    assert.equal(allowed.status, 200);
    assert.deepEqual(JSON.parse(allowed.body), []);
  } finally {
    await close(server);
  }
});

test("token comparison is exact", () => {
  assert.equal(tokensEqual("good", "good"), true);
  assert.equal(tokensEqual("good", "Good"), false);
  assert.equal(tokensEqual("good", "good "), false);
  assert.equal(tokensEqual("", ""), true);
  assert.equal(tokensEqual(null, "good"), false);
});
