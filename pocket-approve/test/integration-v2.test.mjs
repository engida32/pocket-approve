import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFleet } from "../lib/fleet.mjs";
import { createAuthenticator } from "../lib/device-auth.mjs";
import { createPairing } from "../lib/pairing.mjs";
import { createDeviceStore } from "../lib/devices.mjs";

async function fakeServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("two servers with the same raw id stay distinct and reply strictly", async (t) => {
  const requests = {
    a: { id: "per_1", sessionID: "ses_a", permission: "bash", patterns: ["a"], metadata: {} },
    b: { id: "per_1", sessionID: "ses_b", permission: "bash", patterns: ["b"], metadata: {} },
  };
  const replies = { a: [], b: [] };
  const one = await fakeServer((req, res) => {
    if (req.method === "GET") return end(res, [requests.a]);
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { replies.a.push(JSON.parse(body).reply); end(res, { ok: true }); });
  });
  const two = await fakeServer((req, res) => {
    if (req.method === "GET") return end(res, [requests.b]);
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { replies.b.push(JSON.parse(body).reply); end(res, { ok: true }); });
  });
  t.after(() => { one.server.close(); two.server.close(); });
  const fleet = createFleet({
    config: {
      pollIntervalMs: 2000,
      servers: [
        { id: "one", label: "One", url: one.url, enabled: true },
        { id: "two", label: "Two", url: two.url, enabled: true },
      ],
    },
  });
  await fleet.init({ quiet: true });
  await fleet.refreshAll();
  const pending = fleet.pending();
  assert.deepEqual(pending.requests.map((row) => row.id).sort(), ["one:per_1", "two:per_1"]);
  const result = await fleet.reply("two:per_1", "once");
  assert.equal(result.status, 200);
  assert.deepEqual(replies.a, []);
  assert.deepEqual(replies.b, ["once"]);
});

test("one offline server keeps the union at 200 while the other still answers", async (t) => {
  const live = await fakeServer((req, res) => {
    if (req.method === "GET") return end(res, [{
      id: "per_2", sessionID: "ses_2", permission: "bash", patterns: ["ls"], metadata: {},
    }]);
    end(res, { ok: true });
  });
  t.after(() => live.server.close());
  const deadPort = await freePort();
  const fleet = createFleet({
    config: {
      servers: [
        { id: "live", label: "Live", url: live.url, enabled: true },
        { id: "dead", label: "Dead", url: `http://127.0.0.1:${deadPort}`, enabled: true },
      ],
    },
  });
  await fleet.init({ quiet: true });
  await fleet.refreshAll();
  assert.equal(fleet.pending().requests.length, 1);
  const health = fleet.servers();
  assert.equal(health.find((row) => row.id === "dead").ok, false);
  assert.equal(health.find((row) => row.id === "live").ok, true);
});

test("pairing creates a device only after the code matches and revocation kills the token", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pa-int-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const devices = createDeviceStore({ dataDir });
  const pairing = createPairing({ dataDir, secret: Buffer.alloc(32, 3).toString("base64url") });
  await devices.init();
  await pairing.init();
  const { code } = await pairing.open("Phone");
  const bad = await pairing.redeem("AAAA-AAAA", async () => {
    throw new Error("must not create");
  });
  assert.equal(bad.ok, false);
  assert.equal(devices.activeCount(), 0);
  let created;
  const good = await pairing.redeem(code, async () => {
    created = await devices.create("Phone");
  });
  assert.equal(good.ok, true);
  const auth = createAuthenticator({ devices });
  assert.equal((await auth.authenticate({ headers: { authorization: `Bearer ${created.token}` } })).device.id, created.device.id);
  await devices.revoke(created.device.id);
  assert.equal(await auth.authenticate({ headers: { authorization: `Bearer ${created.token}` } }), null);
});

test("a restart does not resurrect an old poller or cache", async (t) => {
  const server = await fakeServer((req, res) => {
    if (req.method === "GET") return end(res, [{
      id: "per_3", sessionID: "ses_3", permission: "bash", patterns: ["pwd"], metadata: {},
    }]);
    end(res, { ok: true });
  });
  t.after(() => server.server.close());
  const config = { servers: [{ id: "one", label: "One", url: server.url, enabled: true }] };
  const first = createFleet({ config });
  await first.init({ quiet: true });
  await first.refreshAll();
  assert.equal(first.pending().requests.length, 1);
  await first.stop();
  const second = createFleet({ config });
  await second.init({ quiet: true });
  assert.equal(second.pending().requests.length, 0);
  await second.refreshAll();
  assert.equal(second.pending().requests.length, 1);
  await second.stop();
});

function end(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
