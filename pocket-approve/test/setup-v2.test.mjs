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

import { execFile } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { backupV2Setup } from "../lib/setup-v2.mjs";

const runNode = promisify(execFile);
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function runSetup(dataDir, args) {
  return runNode(process.execPath, [join(APP_DIR, "scripts/setup-v2.mjs"), ...args], {
    env: { ...process.env, POCKET_APPROVE_DATA: dataDir },
  });
}

function proxyArgs(extra = []) {
  return [
    "--mode", "proxy",
    "--public-origin", "https://approve.example.com",
    "--server", "local=http://127.0.0.1:4096",
    "--no-qr",
    ...extra,
  ];
}

test("proxy mode ignores a previous LAN publicOrigin", () => {
  const previous = {
    mode: "lan",
    publicOrigin: "https://old-lan.example.com",
    httpsPort: 8443,
    setupPort: 8081,
    token: "legacy-token",
    vapid: VAPID,
  };
  assert.throws(
    () => buildSetupConfig({
      options: { mode: "proxy", publicOrigin: null, servers: [], labels: {} },
      previous,
      env: {},
      vapid: VAPID,
      pairingSecret: "pairing-secret-that-is-long-enough",
    }),
    /publicOrigin/,
  );
  const config = buildSetupConfig({
    options: {
      mode: "proxy",
      publicOrigin: "https://approve.example.com",
      servers: [],
      labels: {},
    },
    previous,
    env: {},
    vapid: VAPID,
    pairingSecret: "pairing-secret-that-is-long-enough",
  });
  assert.equal(config.publicOrigin, "https://approve.example.com");
});

test("backupV2Setup copies config and meta with owner-only permissions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pa-setup-v2-backup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = () => new Date("2026-10-25T12:00:00Z");
  assert.equal(await backupV2Setup(dir, now), null);
  const configText = '{"schemaVersion":2,"broken":true}\n';
  const metaText = '{"schemaVersion":2}\n';
  await writeFile(join(dir, "config.json"), configText);
  await writeFile(join(dir, "meta.json"), metaText);

  const backup = await backupV2Setup(dir, now);
  assert.equal(backup, join(dir, "backup-2026-10-25T12-00-00-000Z"));
  assert.equal((await stat(backup)).mode & 0o777, 0o700);
  assert.equal(await readFile(join(backup, "config.json"), "utf8"), configText);
  assert.equal(await readFile(join(backup, "meta.json"), "utf8"), metaText);
  assert.equal((await stat(join(backup, "config.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(backup, "meta.json"))).mode & 0o777, 0o600);
});

test("--force recovers from a corrupt config after backing it up", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pa-setup-v2-corrupt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const corrupt = "{not json\n";
  await writeFile(join(dir, "config.json"), corrupt);

  const { stdout, stderr } = await runSetup(dir, proxyArgs(["--force"]));
  assert.match(`${stdout}${stderr}`, /could not be read/);
  assert.match(`${stdout}${stderr}`, /Backup: /);
  const written = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
  assert.equal(written.mode, "proxy");
  const backups = (await readdir(dir)).filter((name) => name.startsWith("backup-"));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(dir, backups[0], "config.json"), "utf8"), corrupt);
});

test("a corrupt config without --force fails and is left untouched", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pa-setup-v2-corrupt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const corrupt = "{not json\n";
  await writeFile(join(dir, "config.json"), corrupt);

  await assert.rejects(runSetup(dir, proxyArgs()), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /^setup: /m);
    return true;
  });
  assert.equal(await readFile(join(dir, "config.json"), "utf8"), corrupt);
  const backups = (await readdir(dir)).filter((name) => name.startsWith("backup-"));
  assert.equal(backups.length, 0);
});

test("--force with --server replaces a plain-HTTP non-loopback v1 upstream", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pa-setup-v2-legacy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const legacy = JSON.stringify({
    host: "192.168.1.5",
    token: "legacy-token",
    opencodeUrl: "http://192.168.1.10:4096",
    vapid: VAPID,
    pairingSecret: "pairing-secret-that-is-long-enough",
  });
  await writeFile(join(dir, "config.json"), legacy);

  const { stdout, stderr } = await runSetup(dir, [
    "--mode", "proxy",
    "--public-origin", "https://approve.example.com",
    "--server", "local=https://10.0.0.5:4096",
    "--no-qr",
    "--force",
  ]);
  assert.match(`${stdout}${stderr}`, /Backup: /);
  const written = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
  assert.equal(written.mode, "proxy");
  assert.equal(written.servers.length, 1);
  assert.equal(written.servers[0].id, "local");
  assert.equal(written.servers[0].url, "https://10.0.0.5:4096");
  assert.equal(written.vapid.publicKey, VAPID.publicKey);
  assert.equal(written.vapid.privateKey, VAPID.privateKey);
  assert.equal(written.pairingSecret, "pairing-secret-that-is-long-enough");
});

test("--force without --server can be recovered with the advertised flags", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pa-setup-v2-legacy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const legacy = JSON.stringify({
    host: "192.168.1.5",
    token: "legacy-token",
    opencodeUrl: "http://192.168.1.10:4096",
  });
  await writeFile(join(dir, "config.json"), legacy);

  let remedy = null;
  await assert.rejects(runSetup(dir, ["--force"]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /plain-HTTP/);
    assert.match(error.stderr, /delete config\.json/);
    assert.doesNotMatch(error.stderr, /legacy-token/);
    const match = /\(for example: (.+?)\)\./.exec(error.stderr);
    assert.notEqual(match, null);
    remedy = match[1].split(" ");
    return true;
  });
  assert.deepEqual(remedy, [
    "--force",
    "--mode", "proxy",
    "--public-origin", "https://approve.example.com",
    "--server", "local=http://127.0.0.1:4096",
  ]);
  assert.equal(await readFile(join(dir, "config.json"), "utf8"), legacy);
  const backups = (await readdir(dir)).filter((name) => name.startsWith("backup-"));
  assert.equal(backups.length, 0);

  await rm(join(dir, "config.json"));
  await runSetup(dir, remedy);
  const written = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
  assert.equal(written.mode, "proxy");
  assert.equal(written.publicOrigin, "https://approve.example.com");
  assert.equal(written.servers.length, 1);
  assert.equal(written.servers[0].id, "local");
  assert.equal(written.servers[0].url, "http://127.0.0.1:4096");
});

test("the LAN remedy example is executable end to end", { timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pa-setup-v2-legacy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const legacy = JSON.stringify({
    host: "192.168.1.5",
    token: "legacy-token",
    opencodeUrl: "http://192.168.1.10:4096",
  });
  await writeFile(join(dir, "config.json"), legacy);

  let failureStderr = "";
  let remedy = null;
  await assert.rejects(runSetup(dir, ["--force", "--host", "192.168.1.5"]), (error) => {
    assert.equal(error.code, 1);
    failureStderr = error.stderr;
    assert.match(error.stderr, /plain-HTTP/);
    assert.doesNotMatch(error.stderr, /legacy-token/);
    const match = /\(for example: (.+?)\)\./.exec(error.stderr);
    assert.notEqual(match, null);
    remedy = match[1].split(" ");
    return true;
  });
  assert.deepEqual(remedy, [
    "--force",
    "--mode", "lan",
    "--host", "192.168.1.5",
    "--server", "local=http://127.0.0.1:4096",
  ]);
  assert.doesNotMatch(remedy.join(" "), /</);
  assert.equal(await readFile(join(dir, "config.json"), "utf8"), legacy);
  const backups = (await readdir(dir)).filter((name) => name.startsWith("backup-"));
  assert.equal(backups.length, 0);

  await rm(join(dir, "config.json"));
  const { stderr } = await runSetup(dir, remedy);
  assert.doesNotMatch(`${failureStderr}${stderr}`, /legacy-token/);
  const written = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
  assert.equal(written.mode, "lan");
  assert.equal(written.host, "192.168.1.5");
  assert.equal(written.servers.length, 1);
  assert.equal(written.servers[0].url, "http://127.0.0.1:4096");
  assert.equal(written.allowLegacyToken, false);
});
