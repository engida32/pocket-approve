import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSetupConfig,
  buildMeta,
  parseSetupArgs,
  vapidPairFingerprint,
  writeV2Setup,
} from "../lib/setup-v2.mjs";

const VAPID = {
  subject: "mailto:test@example.com",
  publicKey: "public-key",
  privateKey: "private-key",
};

test("parses proxy flags and repeated servers", () => {
  const options = parseSetupArgs([
    "--mode", "proxy",
    "--public-origin", "https://approve.example.com",
    "--server", "local=http://127.0.0.1:4096",
    "--server", "work=https://work.example.com",
    "--server-label", "work=Work box",
    "--no-qr",
  ]);
  assert.equal(options.mode, "proxy");
  assert.equal(options.publicOrigin, "https://approve.example.com");
  assert.deepEqual(options.servers, [
    { id: "local", url: "http://127.0.0.1:4096" },
    { id: "work", url: "https://work.example.com" },
  ]);
  assert.deepEqual(options.labels, { work: "Work box" });
  assert.equal(options.qr, false);
});

test("a bare --host still means legacy LAN mode", () => {
  const options = parseSetupArgs(["--host", "192.168.1.5", "--no-qr"]);
  assert.equal(options.mode, "lan");
  assert.equal(options.host, "192.168.1.5");
});

test("builds a proxy config with no CA, no global token, and a loopback bind", () => {
  const config = buildSetupConfig({
    options: {
      mode: "proxy",
      publicOrigin: "https://approve.example.com",
      servers: [{ id: "local", url: "http://127.0.0.1:4096" }],
      labels: {},
    },
    previous: null,
    env: {},
    vapid: VAPID,
    pairingSecret: "pairing-secret-that-is-long-enough",
  });
  assert.equal(config.mode, "proxy");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.publicOrigin, "https://approve.example.com");
  assert.equal(config.token, null);
  assert.equal(config.allowLegacyToken, false);
  assert.equal(config.servers[0].label, "local");
  assert.equal(config.vapid.publicKey, "public-key");
});

test("builds a LAN config and preserves a v1 token for migration only", () => {
  const config = buildSetupConfig({
    options: { mode: "lan", host: "192.168.1.5", servers: [], labels: {} },
    previous: { token: "legacy-token", httpsPort: 9443, setupPort: 9081, vapid: VAPID },
    env: {},
    vapid: VAPID,
    pairingSecret: "pairing-secret-that-is-long-enough",
  });
  assert.equal(config.mode, "lan");
  assert.equal(config.httpsPort, 9443);
  assert.equal(config.setupPort, 9081);
  assert.equal(config.allowLegacyToken, true);
  assert.equal(config.token, "legacy-token");
});

test("meta records a VAPID fingerprint, not the private key", async () => {
  const meta = buildMeta({ vapid: VAPID, now: () => new Date("2026-10-25T12:00:00Z") });
  assert.equal(meta.schemaVersion, 2);
  assert.equal(meta.createdAt, "2026-10-25T12:00:00.000Z");
  assert.equal(meta.vapidFingerprint, vapidPairFingerprint(VAPID));
  assert.equal(JSON.stringify(meta).includes("private-key"), false);
  assert.match(meta.vapidFingerprint, /^[a-f0-9]{64}$/);
});

test("writeV2Setup creates config and meta with owner-only permissions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pa-setup-v2-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { normalizeConfig } = await import("../lib/config-v2.mjs?" + Date.now());
  const config = normalizeConfig({
    host: "127.0.0.1",
    publicOrigin: "https://approve.example.com",
    servers: [{ id: "local", url: "http://127.0.0.1:4096" }],
    vapid: VAPID,
    pairingSecret: "pairing-secret-that-is-long-enough",
  });
  await writeV2Setup(config, buildMeta({ vapid: VAPID }), dir);
  assert.equal((await stat(join(dir, "config.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, "meta.json"))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(dir, "meta.json"), "utf8")).includes("private-key"), false);
});
