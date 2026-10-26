import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquirePid,
  isAlive,
  isOurProcess,
  pidPath,
  readPid,
  releasePid,
  stopPid,
} from "../lib/ntfy-lifecycle.mjs";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "pa-pid-"));
}

test("acquirePid writes a 0600 file with a decimal PID", async () => {
  const dir = await tempDir();
  const pid = await acquirePid(dir, { pid: 4242, platform: "test" });
  assert.equal(pid, 4242);
  assert.equal((await stat(pidPath(dir))).mode & 0o777, 0o600);
  assert.equal(await readFile(pidPath(dir), "utf8"), "4242\n");
});

test("acquirePid refuses a live owner and replaces a stale file", async () => {
  const dir = await tempDir();
  await writeFile(pidPath(dir), "4242\n", { mode: 0o600 });
  await assert.rejects(
    acquirePid(dir, { pid: 4243, platform: "test", alive: () => true, ours: async () => true }),
    /4242/,
  );
  const pid = await acquirePid(dir, {
    pid: 4244,
    platform: "test",
    alive: () => false,
    ours: async () => false,
  });
  assert.equal(pid, 4244);
  assert.equal(await readFile(pidPath(dir), "utf8"), "4244\n");
});

test("releasePid only removes a matching PID", async () => {
  const dir = await tempDir();
  await writeFile(pidPath(dir), "4242\n", { mode: 0o600 });
  await releasePid(dir, 9999);
  assert.equal(await readPid(dir), 4242);
  await releasePid(dir, 4242);
  assert.equal(await readPid(dir), null);
});

test("readPid returns null for missing and rejects malformed files", async () => {
  const dir = await tempDir();
  assert.equal(await readPid(dir), null);
  await writeFile(pidPath(dir), "not-a-pid\n", { mode: 0o600 });
  await assert.rejects(readPid(dir), /PID/);
});

test("isAlive treats EPERM as alive and ESRCH as dead", () => {
  assert.equal(isAlive(10, () => { throw Object.assign(new Error("no"), { code: "ESRCH" }); }), false);
  assert.equal(isAlive(10, () => { throw Object.assign(new Error("no"), { code: "EPERM" }); }), true);
  assert.equal(isAlive(10, () => {}), true);
});

test("isOurProcess checks the Linux cmdline only", async () => {
  assert.equal(await isOurProcess(10, { platform: "darwin" }), true);
  assert.equal(
    await isOurProcess(10, { platform: "linux", readCmdlineFn: async () => "node scripts/ntfy.mjs" }),
    true,
  );
  assert.equal(
    await isOurProcess(10, { platform: "linux", readCmdlineFn: async () => "node scripts/other.mjs" }),
    false,
  );
});

test("stopPid returns none, stale, or stopped", async () => {
  const dir = await tempDir();
  assert.equal(await stopPid(dir, { platform: "test" }), "none");
  await writeFile(pidPath(dir), "4242\n", { mode: 0o600 });
  assert.equal(await stopPid(dir, { platform: "test", alive: () => false }), "stale");
  await writeFile(pidPath(dir), "4242\n", { mode: 0o600 });
  const signals = [];
  assert.equal(
    await stopPid(dir, {
      platform: "test",
      alive: () => true,
      ours: async () => true,
      kill: (pid, signal) => signals.push([pid, signal]),
      sleep: async () => {},
      wait: async () => "dead",
    }),
    "stopped",
  );
  assert.deepEqual(signals, [[4242, "SIGTERM"]]);
  assert.equal(await readPid(dir), null);
});

test("stopPid does not signal a PID whose cmdline is not ntfy", async () => {
  const dir = await tempDir();
  await writeFile(pidPath(dir), "4242\n", { mode: 0o600 });
  const signals = [];
  assert.equal(
    await stopPid(dir, {
      platform: "linux",
      alive: () => true,
      readCmdlineFn: async () => "node scripts/other.mjs",
      kill: (pid, signal) => signals.push([pid, signal]),
    }),
    "stale",
  );
  assert.deepEqual(signals, []);
  assert.equal(await readPid(dir), null);
});

test("stopPid reports timeout without SIGKILL", async () => {
  const dir = await tempDir();
  await writeFile(pidPath(dir), "4242\n", { mode: 0o600 });
  const signals = [];
  assert.equal(
    await stopPid(dir, {
      platform: "test",
      alive: () => true,
      ours: async () => true,
      kill: (pid, signal) => signals.push([pid, signal]),
      sleep: async () => {},
      wait: async () => "alive",
    }),
    "timeout",
  );
  assert.deepEqual(signals, [[4242, "SIGTERM"]]);
  assert.equal(await readPid(dir), 4242);
});

test("stopPid settles after a real child exits", async () => {
  const dir = await tempDir();
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  await writeFile(pidPath(dir), `${child.pid}\n`, { mode: 0o600 });
  const result = await stopPid(dir, { platform: "test", timeoutMs: 3000, intervalMs: 50 });
  assert.equal(result, "stopped");
  assert.equal(await readPid(dir), null);
});
