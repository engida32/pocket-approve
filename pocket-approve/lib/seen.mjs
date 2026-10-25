import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "./store.mjs";

const FILE = "seen.json";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ABSENT_TTL_MS = 60 * 60 * 1000;

function positiveMs(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return value;
}

function recordFrom(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!Number.isFinite(value.firstSeenAt)) return null;
  const lastPresentAt = Number.isFinite(value.lastPresentAt) ? value.lastPresentAt : value.firstSeenAt;
  return { firstSeenAt: value.firstSeenAt, lastPresentAt };
}

function activeSet(activeIds) {
  if (activeIds instanceof Set) return activeIds;
  if (Array.isArray(activeIds)) {
    return new Set(activeIds.filter((id) => typeof id === "string" && id !== ""));
  }
  return new Set();
}

export function createSeenStore({
  dataDir,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  absentTtlMs = DEFAULT_ABSENT_TTL_MS,
} = {}) {
  if (typeof dataDir !== "string" || dataDir.trim() === "") {
    throw new TypeError("dataDir must be a non-empty string");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const ttl = positiveMs(ttlMs, "ttlMs");
  const absentTtl = positiveMs(absentTtlMs, "absentTtlMs");
  const file = join(dataDir, FILE);
  let records = Object.create(null);
  let initialized = false;
  let queue = Promise.resolve();

  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function load() {
    const loaded = await readPrivateJson(file, {});
    const next = Object.create(null);
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
      for (const [id, value] of Object.entries(loaded)) {
        if (id === "") continue;
        const record = recordFrom(value);
        if (record) next[id] = record;
      }
    }
    records = next;
    initialized = true;
  }

  const init = () => enqueue(load);

  async function takeNew(items) {
    return enqueue(async () => {
      if (!initialized) await load();
      if (!Array.isArray(items)) return [];
      const at = now();
      const next = Object.assign(Object.create(null), records);
      const fresh = [];
      for (const item of items) {
        if (!item || typeof item !== "object" || typeof item.id !== "string" || item.id === "") continue;
        if (Object.hasOwn(next, item.id)) continue;
        next[item.id] = { firstSeenAt: at, lastPresentAt: at };
        fresh.push(item);
      }
      if (fresh.length === 0) return [];
      await writePrivateJson(file, next);
      records = next;
      return fresh;
    });
  }

  async function observe(activeIds) {
    const active = activeSet(activeIds);
    return enqueue(async () => {
      if (!initialized) await load();
      const at = now();
      const next = Object.create(null);
      let changed = false;
      for (const [id, record] of Object.entries(records)) {
        if (at - record.firstSeenAt > ttl) {
          changed = true;
          continue;
        }
        if (active.has(id)) {
          if (record.lastPresentAt === at) {
            next[id] = record;
          } else {
            next[id] = { ...record, lastPresentAt: at };
            changed = true;
          }
          continue;
        }
        if (at - record.lastPresentAt > absentTtl) {
          changed = true;
          continue;
        }
        next[id] = record;
      }
      if (!changed) return;
      await writePrivateJson(file, next);
      records = next;
    });
  }

  return {
    init,
    takeNew,
    observe,
    has: (id) => typeof id === "string" && Object.hasOwn(records, id),
    size: () => Object.keys(records).length,
  };
}
