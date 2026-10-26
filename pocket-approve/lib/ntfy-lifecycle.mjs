import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PID_FILE = "ntfy.pid";

export function pidPath(dataDir) {
  return join(dataDir, PID_FILE);
}

export async function readPid(dataDir) {
  let raw;
  try {
    raw = await readFile(pidPath(dataDir), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid PID file: ${pidPath(dataDir)}`);
  }
  return value;
}

export function isAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return false;
    return false;
  }
}

export async function readCmdline(pid, readFn = (file) => readFile(file, "utf8")) {
  try {
    const raw = await readFn(`/proc/${pid}/cmdline`);
    return raw.split("\0").join(" ");
  } catch {
    return "";
  }
}

export async function isOurProcess(pid, {
  platform = process.platform,
  readCmdlineFn = readCmdline,
} = {}) {
  if (platform !== "linux") return true;
  const cmdline = await readCmdlineFn(pid);
  return cmdline.includes("scripts/ntfy.mjs");
}

export async function acquirePid(dataDir, {
  pid = process.pid,
  alive = isAlive,
  ours = isOurProcess,
  readCmdlineFn,
  platform = process.platform,
} = {}) {
  let existing = null;
  try {
    existing = await readPid(dataDir);
  } catch {
    await unlink(pidPath(dataDir)).catch(() => {});
  }
  if (existing !== null) {
    if (alive(existing) && await ours(existing, { platform, readCmdlineFn })) {
      throw new Error(`Pocket Approve connect is already running (PID ${existing}). Run: npm run disconnect`);
    }
    await unlink(pidPath(dataDir)).catch(() => {});
  }
  await writeFile(pidPath(dataDir), `${pid}\n`, { mode: 0o600, flag: "wx" });
  return pid;
}

export async function releasePid(dataDir, pid) {
  const existing = await readPid(dataDir);
  if (existing === pid) await unlink(pidPath(dataDir)).catch(() => {});
}

export async function stopPid(dataDir, {
  platform = process.platform,
  alive = isAlive,
  ours = isOurProcess,
  readCmdlineFn,
  kill = process.kill,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  wait = null,
  timeoutMs = 5000,
  intervalMs = 100,
} = {}) {
  let pid;
  try {
    pid = await readPid(dataDir);
  } catch {
    await unlink(pidPath(dataDir)).catch(() => {});
    return "stale";
  }
  if (pid === null) return "none";
  if (!alive(pid) || !(await ours(pid, { platform, readCmdlineFn }))) {
    await unlink(pidPath(dataDir)).catch(() => {});
    return "stale";
  }
  try {
    kill(pid, "SIGTERM");
  } catch {
    if (!alive(pid)) {
      await unlink(pidPath(dataDir)).catch(() => {});
      return "stopped";
    }
    return "timeout";
  }
  const settle = wait ?? (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(intervalMs);
      if (!alive(pid)) return "dead";
    }
    return "alive";
  });
  const result = await settle();
  if (result === "dead") {
    await unlink(pidPath(dataDir)).catch(() => {});
    return "stopped";
  }
  return "timeout";
}
