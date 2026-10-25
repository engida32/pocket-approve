import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("saveConfig writes mode 0600 and round-trips", async () => {
  process.env.POCKET_APPROVE_DATA = await mkdtemp(join(tmpdir(), "pa-"));
  const { saveConfig, loadConfig } = await import("../lib/config.mjs?" + Date.now());
  await saveConfig({ host: "192.168.1.5", httpsPort: 8443, setupPort: 8081, token: "t" });
  assert.equal((await stat(join(process.env.POCKET_APPROVE_DATA, "config.json"))).mode & 0o777, 0o600);
  assert.equal((await loadConfig()).host, "192.168.1.5");
});
