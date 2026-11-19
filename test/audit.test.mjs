import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditLog } from "../lib/audit.mjs";

test("writes only whitelisted fields and never secrets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pa-audit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const audit = createAuditLog({
    dataDir: dir,
    now: () => new Date("2026-10-25T12:00:00.000Z"),
  });
  await audit.append("reply", {
    deviceId: "dev_abc12345",
    serverId: "work",
    requestId: "per_1",
    result: "ok",
    token: "secret",
    password: "secret",
    metadata: { command: "rm -rf /" },
  });
  const lines = (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    action: "reply",
    at: "2026-10-25T12:00:00.000Z",
    deviceId: "dev_abc12345",
    serverId: "work",
    requestId: "per_1",
    result: "ok",
  });
  assert.equal((await stat(join(dir, "audit.jsonl"))).mode & 0o777, 0o600);
  await assert.rejects(audit.append("token_dump"), /action/i);
});

test("a write failure is logged and does not reject", async (t) => {
  const calls = [];
  const audit = createAuditLog({
    dataDir: "/proc/definitely-not-writable",
    log: { error: (...args) => calls.push(args) },
  });
  await audit.append("auth_failed", { result: "bad_token" });
  assert.equal(calls.length, 1);
});
