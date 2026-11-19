import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { createAdmin } from "../lib/admin.mjs";
import { createFleet } from "../lib/fleet.mjs";
import { createGenericSource } from "../lib/adapters/generic.mjs";
import { normalizeConfig } from "../lib/config-v2.mjs";

async function emptyUpstream(t) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("[]");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function send(socketPath, message) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolve(JSON.parse(data)));
    socket.on("error", reject);
  });
}

async function waitFor(predicate, budgetMs = 2000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

test("a generic ask is listed, answered once, and then forgotten", async () => {
  const generic = createGenericSource();
  const asked = generic.ask({ title: "Deploy to production?", body: "commit a1b2c3" });
  const listed = generic.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, asked.id);
  assert.equal(listed[0].title, "Deploy to production?");
  assert.equal(listed[0].summary, "commit a1b2c3");
  assert.equal(listed[0].tool, "cli");

  assert.deepEqual(generic.reply(asked.id, "once"), { ok: true, id: asked.id, decision: "once" });
  assert.deepEqual(await asked.promise, { decision: "once", timedOut: false });
  assert.equal(generic.size(), 0);
  assert.throws(() => generic.reply(asked.id, "once"), { status: 404 });
  assert.throws(() => generic.ask({ title: "  " }), { status: 400 });
});

test("an unanswered ask times out and leaves the queue", async () => {
  const generic = createGenericSource();
  const asked = generic.ask({ title: "Continue?", timeoutMs: 30 });
  assert.deepEqual(await asked.promise, { decision: null, timedOut: true });
  assert.equal(generic.size(), 0);
});

test("attached requests share the fleet cache, replies, and pending payload", async (t) => {
  const url = await emptyUpstream(t);
  const config = normalizeConfig({
    host: "127.0.0.1",
    publicOrigin: "https://approve.example.com",
    servers: [{ id: "opencode", label: "OpenCode", url }],
  });
  const generic = createGenericSource();
  const replies = [];
  const fleet = createFleet({ config, onReply: (event) => replies.push(event) });
  fleet.attach({ id: "local", label: "Terminal", source: generic });
  const links = await fleet.init();
  assert.deepEqual(links.map((link) => link.id).sort(), ["local", "opencode"]);

  const asked = generic.ask({ title: "Run the migration?" });
  await fleet.refresh("local");
  const pending = fleet.pending().requests;
  assert.deepEqual(pending.map((item) => item.id), [`local:${asked.id}`]);
  assert.equal(pending[0].serverLabel, "Terminal");
  assert.equal(pending[0].title, "Run the migration?");

  assert.deepEqual(await fleet.reply(`local:${asked.id}`, "always"), { status: 200 });
  assert.deepEqual(replies, [{ id: `local:${asked.id}`, decision: "always", status: 200 }]);
  assert.deepEqual(await asked.promise, { decision: "always", timedOut: false });
  assert.equal(fleet.pending().requests.length, 0);
  assert.deepEqual(await fleet.reply(`local:${asked.id}`, "once"), { status: 404, error: "unknown_request" });
});

test("the admin socket blocks on an ask until the phone answers", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pa-generic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "admin.sock");
  const generic = createGenericSource();
  const admin = createAdmin({
    socketPath,
    config: { mode: "proxy", publicOrigin: "https://approve.example.com", servers: [], vapid: {}, pairingSecret: "12345678901234567890" },
    devices: { list: () => [], activeCount: () => 0 },
    pairing: { open: async () => ({ code: "ABCD-EFGH", expiresAt: "x" }) },
    push: { removeByDevice: async () => 0 },
    fleet: { refresh: async () => true, servers: () => [] },
    generic,
    localId: "local",
    audit: { append: async () => {} },
  });
  await admin.start();
  t.after(() => admin.stop());

  const pending = send(socketPath, { command: "ask", title: "Ship it?", body: "tag v2.0.1" });
  const item = await waitFor(() => generic.list()[0]);
  assert.equal(item.title, "Ship it?");
  generic.reply(item.id, "reject");
  const result = await pending;
  assert.deepEqual(result, { ok: true, id: item.id, decision: "reject" });

  const invalid = await send(socketPath, { command: "ask", title: " " });
  assert.deepEqual(invalid, { ok: false, error: "invalid_title" });

  const timedOut = await send(socketPath, { command: "ask", title: "Nobody home", timeoutMs: 40 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error, "timed_out");
});
