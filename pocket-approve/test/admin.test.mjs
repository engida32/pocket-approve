import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { createAdmin } from "../lib/admin.mjs";

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "pa-admin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function send(socketPath, message) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(JSON.stringify(message) + "\n"));
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolve(JSON.parse(data)));
    socket.on("error", reject);
  });
}

test("admin socket is private and pairs through the same code store", async (t) => {
  const dir = await temp(t);
  const socketPath = join(dir, "admin.sock");
  const opened = [];
  const admin = createAdmin({
    socketPath,
    config: {
      mode: "proxy",
      publicOrigin: "https://approve.example.com",
      servers: [{ id: "local", label: "Laptop", url: "http://127.0.0.1:4096" }],
      vapid: { publicKey: "pub" },
      pairingSecret: "secret",
    },
    devices: { list: () => [], activeCount: () => 0 },
    pairing: { open: async (label) => { opened.push(label); return { code: "ABCD-EFGH", expiresAt: "2026-10-25T12:10:00.000Z" }; } },
    push: { removeByDevice: async () => 0 },
    fleet: { servers: () => [{ id: "local", label: "Laptop", ok: true }] },
    audit: { append: async () => {} },
  });
  await admin.start();
  t.after(() => admin.stop());
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
  const pair = await send(socketPath, { command: "pair", label: "Ada" });
  assert.equal(pair.ok, true);
  assert.equal(pair.code, "ABCD-EFGH");
  assert.equal(pair.url, "https://approve.example.com/pair#code=ABCD-EFGH");
  assert.deepEqual(opened, ["Ada"]);
  const unknown = await send(socketPath, { command: "shell" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "unknown_command");
});

test("revoke removes device subscriptions and doctor never prints secrets", async (t) => {
  const dir = await temp(t);
  const revoked = [];
  const removed = [];
  const admin = createAdmin({
    socketPath: join(dir, "admin.sock"),
    config: {
      mode: "proxy",
      publicOrigin: "https://approve.example.com",
      servers: [{ id: "local", label: "Laptop", url: "http://127.0.0.1:4096", password: "super-secret" }],
      vapid: { publicKey: "pub" },
      pairingSecret: "pairing-secret",
    },
    devices: {
      list: () => [{ id: "dev_1", name: "Phone", tokenHash: "sha256:abc", createdAt: "2026-10-25T12:00:00Z", revokedAt: null }],
      activeCount: () => 1,
      revoke: async (id) => { revoked.push(id); return true; },
    },
    pairing: { open: async () => ({ code: "ABCD-EFGH", expiresAt: "x" }) },
    push: { removeByDevice: async (id) => { removed.push(id); return 1; } },
    fleet: { servers: () => [{ id: "local", label: "Laptop", ok: true, pending: 2 }] },
    audit: { append: async () => {} },
  });
  await admin.start();
  t.after(() => admin.stop());
  const revoke = await send(join(dir, "admin.sock"), { command: "revoke", id: "dev_1" });
  assert.equal(revoke.ok, true);
  assert.deepEqual(revoked, ["dev_1"]);
  assert.deepEqual(removed, ["dev_1"]);
  const doctor = await send(join(dir, "admin.sock"), { command: "doctor" });
  assert.equal(doctor.ok, true);
  assert.equal(JSON.stringify(doctor).includes("super-secret"), false);
  assert.equal(JSON.stringify(doctor).includes("pairing-secret"), false);
  assert.equal(doctor.checks.some((check) => check.name === "servers" && check.ok), true);
});

test("start retries after a failed listen and stop stays safe", async (t) => {
  const dir = await temp(t);
  const socketPath = join(dir, "admin.sock");
  await writeFile(socketPath, "not a socket");
  const admin = createAdmin({
    socketPath,
    config: {
      mode: "proxy",
      publicOrigin: "https://approve.example.com",
      servers: [{ id: "local", label: "Laptop", url: "http://127.0.0.1:4096" }],
      vapid: { publicKey: "pub" },
      pairingSecret: "12345678901234567890",
    },
    devices: { list: () => [], activeCount: () => 0 },
    pairing: { open: async () => ({ code: "ABCD-EFGH", expiresAt: "x" }) },
    push: { removeByDevice: async () => 0 },
    fleet: { servers: () => [{ id: "local", label: "Laptop", ok: true }] },
    audit: { append: async () => {} },
  });
  t.after(() => admin.stop());
  await assert.rejects(() => admin.start(), { code: "EADDRINUSE" });
  await admin.stop();
  await rm(socketPath, { force: true });
  await admin.start();
  const devices = await send(socketPath, { command: "devices" });
  assert.equal(devices.ok, true);
  assert.deepEqual(devices.devices, []);
});

test("half-closed client still receives a delayed pair response", async (t) => {
  const dir = await temp(t);
  const socketPath = join(dir, "admin.sock");
  const admin = createAdmin({
    socketPath,
    config: {
      mode: "proxy",
      publicOrigin: "https://approve.example.com",
      servers: [{ id: "local", label: "Laptop", url: "http://127.0.0.1:4096" }],
      vapid: { publicKey: "pub" },
      pairingSecret: "12345678901234567890",
    },
    devices: { list: () => [], activeCount: () => 0 },
    pairing: {
      open: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { code: "ABCD-EFGH", expiresAt: "2026-10-25T12:10:00.000Z" };
      },
    },
    push: { removeByDevice: async () => 0 },
    fleet: { servers: () => [] },
    audit: { append: async () => { await new Promise((resolve) => setTimeout(resolve, 25)); } },
  });
  await admin.start();
  t.after(() => admin.stop());
  const result = await new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for the pair response"));
    }, 2000);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(JSON.stringify({ command: "pair", label: "Half close" }) + "\n"));
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, "ABCD-EFGH");
  assert.equal(result.url, "https://approve.example.com/pair#code=ABCD-EFGH");
});
