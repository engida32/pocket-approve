import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { normalizeConfig } from "../lib/config-v2.mjs";
import { createFleet } from "../lib/fleet.mjs";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function fakeServer(port, { reject = false } = {}) {
  const replies = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/permission") {
      return json(res, 200, [{
        id: "per_1",
        sessionID: "ses_1",
        permission: "bash",
        patterns: ["git status"],
        always: ["git status"],
        tool: "bash",
        metadata: { command: "git status" },
      }]);
    }
    if (req.method === "POST" && req.url === "/permission/per_1/reply") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        replies.push(JSON.parse(body));
        if (reject) return json(res, 401, { error: "unauthorized" });
        return json(res, 200, { ok: true });
      });
      return;
    }
    json(res, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, replies, url: `http://127.0.0.1:${server.address().port}` };
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("colliding raw ids become separate cards and replies are strict", async (t) => {
  const a = await fakeServer(0);
  const b = await fakeServer(0);
  t.after(() => { a.server.close(); b.server.close(); });
  const config = normalizeConfig({
    host: "127.0.0.1",
    publicOrigin: "https://approve.example.com",
    servers: [
      { id: "alpha", label: "Alpha", url: a.url },
      { id: "beta", label: "Beta", url: b.url },
    ],
  });
  const fleet = createFleet({ config });
  await fleet.init();
  await fleet.refreshAll();
  const pending = fleet.pending();
  assert.deepEqual(pending.requests.map((item) => item.id).sort(), ["alpha:per_1", "beta:per_1"]);
  assert.equal(pending.requests[0].serverLabel.length > 0, true);
  assert.deepEqual(pending.requests[0].always, ["git status"]);
  assert.equal(pending.requests[0].tool, "bash");

  assert.deepEqual(await fleet.reply("alpha:per_1", "once"), { status: 200 });
  assert.deepEqual(a.replies, [{ reply: "once" }]);
  assert.deepEqual(b.replies, []);
  assert.equal(fleet.pending().requests.some((item) => item.id === "alpha:per_1"), false);
  assert.equal(fleet.pending().requests.some((item) => item.id === "beta:per_1"), true);
  assert.deepEqual(await fleet.reply("gamma:per_1", "once"), { status: 404, error: "unknown_request" });
  assert.deepEqual(await fleet.reply("per_1", "once"), { status: 404, error: "unknown_request" });
});

test("an offline server keeps its cache and does not block the other server", async (t) => {
  const a = await fakeServer(0);
  const deadPort = await freePort();
  t.after(() => a.server.close());
  const config = normalizeConfig({
    host: "127.0.0.1",
    publicOrigin: "https://approve.example.com",
    servers: [
      { id: "up", label: "Up", url: a.url },
      { id: "down", label: "Down", url: `http://127.0.0.1:${deadPort}` },
    ],
  });
  const fleet = createFleet({ config });
  await fleet.init();
  await fleet.refreshAll();
  const pending = fleet.pending();
  assert.equal(pending.requests.length, 1);
  assert.equal(pending.requests[0].id, "up:per_1");
  const down = pending.servers.find((item) => item.id === "down");
  assert.equal(down.ok, false);
  assert.match(down.lastError, /offline|unavailable/);
  assert.equal(pending.servers.find((item) => item.id === "up").ok, true);
});

test("upstream 401 on reply keeps the card and returns a server error", async (t) => {
  const a = await fakeServer(0, { reject: true });
  t.after(() => a.server.close());
  const config = normalizeConfig({
    host: "127.0.0.1",
    publicOrigin: "https://approve.example.com",
    servers: [{ id: "alpha", url: a.url }],
  });
  const fleet = createFleet({ config });
  await fleet.init();
  await fleet.refreshAll();
  const result = await fleet.reply("alpha:per_1", "reject");
  assert.equal(result.status, 502);
  assert.equal(result.error, "server_unauthorized");
  assert.equal(fleet.pending().requests.length, 1);
});

test("a missing password environment variable is a per-server config error", async () => {
  const config = normalizeConfig({
    host: "127.0.0.1",
    publicOrigin: "https://approve.example.com",
    servers: [
      { id: "bad", url: "http://127.0.0.1:4096", passwordEnv: "PA_TEST_MISSING_PASSWORD" },
      { id: "good", url: "http://127.0.0.1:4097" },
    ],
  });
  delete process.env.PA_TEST_MISSING_PASSWORD;
  const fleet = createFleet({ config });
  await fleet.init();
  const bad = fleet.servers().find((item) => item.id === "bad");
  assert.equal(bad.ok, false);
  assert.equal(bad.lastError, "config_error");
});

function permission(id = "per_1") {
  return {
    id,
    sessionID: "ses_1",
    permission: "bash",
    patterns: ["git status"],
    always: ["git status"],
    tool: "bash",
    metadata: { command: "git status" },
  };
}

function quietLog() {
  return { log() {}, warn() {}, error() {} };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("condition was not met before the deadline");
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function shortConfig(url, id = "a") {
  const config = normalizeConfig({
    host: "127.0.0.1",
    publicOrigin: "https://approve.example.com",
    servers: [{ id, label: id.toUpperCase(), url }],
  });
  return { ...config, pollIntervalMs: 35 };
}

test("start before init is safe and start after stop resumes polling", async (t) => {
  const state = { lists: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/permission") {
      state.lists += 1;
      return json(res, 200, [permission()]);
    }
    json(res, 404, { error: "not found" });
  });
  const { url } = await listen(server);
  const fleet = createFleet({
    config: shortConfig(url),
    log: quietLog(),
    random: () => 0.5,
  });
  t.after(async () => {
    await fleet.stop();
    await new Promise((resolve) => server.close(resolve));
  });

  fleet.start();
  assert.equal(fleet.serverCount(), 0);
  await fleet.init();
  fleet.start();
  await waitFor(() => state.lists >= 2);
  await fleet.stop();

  const afterStop = state.lists;
  await delay(150);
  assert.equal(state.lists, afterStop);

  fleet.start();
  await waitFor(() => state.lists >= afterStop + 2);
  await fleet.stop();
});

test("repeated init does not duplicate servers or cards", async (t) => {
  const a = await fakeServer(0);
  const b = await fakeServer(0);
  t.after(() => { a.server.close(); b.server.close(); });
  const config = normalizeConfig({
    host: "127.0.0.1",
    publicOrigin: "https://approve.example.com",
    servers: [
      { id: "alpha", label: "Alpha", url: a.url },
      { id: "beta", label: "Beta", url: b.url },
    ],
  });
  const fleet = createFleet({ config, log: quietLog() });
  await fleet.init();
  await fleet.init();
  assert.equal(fleet.serverCount(), 2);
  assert.equal(fleet.servers().length, 2);
  await fleet.refreshAll();
  assert.deepEqual(fleet.pending().requests.map((item) => item.id).sort(), ["alpha:per_1", "beta:per_1"]);
  assert.deepEqual(await fleet.reply("alpha:per_1", "once"), { status: 200 });
  assert.deepEqual(fleet.pending().requests.map((item) => item.id), ["beta:per_1"]);
});

test("a poll in flight across a successful reply does not restore the card", async (t) => {
  let listCalls = 0;
  let signalSecond;
  const secondStarted = new Promise((resolve) => { signalSecond = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/permission") {
      listCalls += 1;
      if (listCalls === 1) return json(res, 200, [permission()]);
      signalSecond();
      return gate.then(() => json(res, 200, [permission()]));
    }
    if (req.method === "POST" && req.url === "/permission/per_1/reply") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => json(res, 200, JSON.parse(body)));
      return;
    }
    json(res, 404, { error: "not found" });
  });
  const { url } = await listen(server);
  const fleet = createFleet({ config: shortConfig(url), log: quietLog() });
  t.after(async () => {
    await fleet.stop();
    await new Promise((resolve) => server.close(resolve));
  });

  await fleet.init();
  await fleet.refreshAll();
  const inFlight = fleet.refreshAll();
  await secondStarted;
  assert.deepEqual(await fleet.reply("a:per_1", "once"), { status: 200 });
  assert.equal(fleet.pending().requests.length, 0);

  release();
  await inFlight;
  assert.equal(fleet.pending().requests.length, 0);
  assert.equal(fleet.servers().find((item) => item.id === "a").ok, true);
});

test("concurrent replies to the same id return 409", async (t) => {
  let signalReply;
  const replyStarted = new Promise((resolve) => { signalReply = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const posts = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/permission") {
      return json(res, 200, [permission()]);
    }
    if (req.method === "POST" && req.url === "/permission/per_1/reply") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        posts.push(JSON.parse(body));
        signalReply();
        gate.then(() => json(res, 200, { ok: true }));
      });
      return;
    }
    json(res, 404, { error: "not found" });
  });
  const { url } = await listen(server);
  const fleet = createFleet({ config: shortConfig(url), log: quietLog() });
  t.after(async () => {
    await fleet.stop();
    await new Promise((resolve) => server.close(resolve));
  });

  await fleet.init();
  await fleet.refreshAll();
  const first = fleet.reply("a:per_1", "once");
  await replyStarted;
  assert.deepEqual(await fleet.reply("a:per_1", "always"), { status: 409, error: "already_in_flight" });
  release();
  assert.deepEqual(await first, { status: 200 });
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { reply: "once" });
  assert.equal(fleet.pending().requests.length, 0);
});

test("an upstream 404 on reply maps to not_found and drops the card", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/permission") {
      return json(res, 200, [permission()]);
    }
    if (req.method === "POST" && req.url === "/permission/per_1/reply") {
      return json(res, 404, { error: "missing" });
    }
    json(res, 404, { error: "not found" });
  });
  const { url } = await listen(server);
  const fleet = createFleet({ config: shortConfig(url), log: quietLog() });
  t.after(async () => {
    await fleet.stop();
    await new Promise((resolve) => server.close(resolve));
  });

  await fleet.init();
  await fleet.refreshAll();
  assert.deepEqual(await fleet.reply("a:per_1", "reject"), { status: 404, error: "not_found" });
  assert.equal(fleet.pending().requests.length, 0);
});
