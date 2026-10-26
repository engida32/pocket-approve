import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export const AUDIT_ACTIONS = new Set([
  "pair",
  "pair_failed",
  "revoke",
  "reply",
  "subscribe",
  "unsubscribe",
  "test_notification",
  "auth_failed",
  "legacy_auth",
  "config_warning",
]);

const FIELDS = ["deviceId", "serverId", "requestId", "result"];
const SECRET_PATTERN = /token|password|secret|hash|code/i;

async function makeDir(dir) {
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") return;
    if (error.code !== "ENOENT") throw error;
    await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (again) {
      if (again.code !== "EEXIST") throw again;
    }
  }
}

export function createAuditLog({ dataDir, now = () => new Date(), log = console } = {}) {
  if (!dataDir) throw new TypeError("dataDir is required");
  const file = join(dataDir, "audit.jsonl");
  let queue = Promise.resolve();

  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function write(record) {
    return enqueue(async () => {
      await makeDir(dataDir);
      await chmod(dataDir, 0o700);
      await appendFile(file, JSON.stringify(record) + "\n", { mode: 0o600 });
      await chmod(file, 0o600);
    });
  }

  async function append(action, fields = {}) {
    if (!AUDIT_ACTIONS.has(action)) throw new TypeError("unknown audit action");
    const record = { action, at: now().toISOString() };
    for (const name of FIELDS) {
      const value = fields[name];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" || SECRET_PATTERN.test(name)) continue;
      record[name] = value.length > 128 ? value.slice(0, 128) : value;
    }
    try {
      await write(record);
    } catch (error) {
      try {
        log?.error?.("audit: write failed", error);
      } catch {}
    }
  }

  return { append };
}
