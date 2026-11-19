import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import { normalizeConfig } from "../lib/config-v2.mjs";
import { createRuntime, start } from "../lib/runtime.mjs";

async function dir(t) {
  const value = await mkdtemp(join(tmpdir(), "pa-runtime-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

function configFor(vapid) {
  return normalizeConfig({
    mode: "proxy",
    host: "127.0.0.1",
    publicOrigin: "https://approve.example.com",
    servers: [{ id: "local", label: "Laptop", url: "http://127.0.0.1:1" }],
    vapid: { ...vapid, subject: "mailto:test@example.com" },
    pairingSecret: Buffer.alloc(32, 3).toString("base64url"),
    allowLegacyToken: false,
  });
}

test("proxy runtime composes the fleet, app, and admin socket without TLS", async (t) => {
  const dataDir = await dir(t);
  const vapid = webpush.generateVAPIDKeys();
  const desktop = {
    notified: [],
    async notify(request) { this.notified.push(request); return null; },
    async close() {},
    async stop() {},
  };
  const runtime = await createRuntime({
    config: configFor(vapid),
    dataDir,
    desktop,
    log: { error() {} },
  });
  assert.equal(typeof runtime.app.handler, "function");
  assert.equal(runtime.app.setupHandler, undefined);
  await runtime.start();
  assert.equal(runtime.fleet.serverCount(), 1);
  const socket = join(dataDir, "admin.sock");
  assert.equal((await stat(socket)).mode & 0o777, 0o600);
  await runtime.stop();
});

test("start cleans up the runtime when a listener fails", async (t) => {
  const dataDir = await dir(t);
  const vapid = webpush.generateVAPIDKeys();
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => blocker.close(() => resolve())));
  const port = blocker.address().port;
  const config = { ...configFor(vapid), httpPort: port };

  await assert.rejects(start({ config, dataDir, log: { error() {} } }), /EADDRINUSE/);

  await new Promise((resolve) => blocker.close(() => resolve()));
  const running = await start({ config, dataDir, log: { error() {} } });
  assert.equal(running.port, port);
  await running.stop();
});

test("runtime refuses a proxy config without a pairing secret", async (t) => {
  const dataDir = await dir(t);
  const vapid = webpush.generateVAPIDKeys();
  const config = configFor(vapid);
  config.pairingSecret = null;
  await assert.rejects(createRuntime({
    config,
    dataDir,
    desktop: { notify: async () => null, close: async () => {}, stop: async () => {} },
    log: { error() {} },
  }), /pairing secret/i);
});

test("LAN setup handler serves only the CA page and certificate", async (t) => {
  const dataDir = await dir(t);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dataDir, "ca.crt"), "CERT\n");
  const { createLanSetupHandler } = await import("../lib/runtime.mjs");
  const handler = createLanSetupHandler({ dataDir, log: { error() {} } });
  const page = await handler(new Request("http://192.168.1.5:8081/"));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /ca\.crt/);
  const cert = await handler(new Request("http://192.168.1.5:8081/ca.crt"));
  assert.equal(cert.status, 200);
  assert.equal(await cert.text(), "CERT\n");
  const missing = await handler(new Request("http://192.168.1.5:8081/../config.json"));
  assert.equal(missing.status, 404);
});

test("runtime.stop is idempotent", async (t) => {
  const dataDir = await dir(t);
  const vapid = webpush.generateVAPIDKeys();
  const runtime = await createRuntime({
    config: configFor(vapid),
    dataDir,
    desktop: { notify: async () => null, close: async () => {}, stop: async () => {} },
    log: { error() {} },
  });
  await runtime.start();
  await runtime.stop();
  await runtime.stop();
});
