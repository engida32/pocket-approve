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
