import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { certHasIp, readTls } from "../lib/tls.mjs";

const run = promisify(execFile);

test("setup generates a cert for the LAN IP", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pa-tls-"));
  await run(process.execPath, ["scripts/setup.mjs", "--host", "192.168.100.2", "--no-qr"], {
    env: { ...process.env, POCKET_APPROVE_DATA: dataDir },
  });
  assert.equal(await certHasIp(join(dataDir, "server.crt"), "192.168.100.2"), true);
  assert.equal(await certHasIp(join(dataDir, "server.crt"), "10.0.0.1"), false);
  const tls = await readTls(dataDir);
  assert.match(tls.key, /BEGIN PRIVATE KEY/);
  assert.match(tls.cert, /BEGIN CERTIFICATE/);
});
