import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { hashToken } from "./auth.mjs";
import { readPrivateJson, writePrivateJson } from "./store.mjs";

const TOKEN_BYTES = 32;
const LAST_SEEN_MS = 60_000;
const TOKEN_HASH = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_SCOPES = ["read", "approve"];

function isoOrNull(value) {
  if (typeof value !== "string") return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function normalizeDevice(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  if (typeof item.id !== "string" || item.id.length === 0) return null;
  if (typeof item.tokenHash !== "string" || !TOKEN_HASH.test(item.tokenHash)) return null;
  const createdAt = item.createdAt == null ? null : isoOrNull(item.createdAt);
  if (item.createdAt != null && createdAt === null) return null;
  const revokedAt = item.revokedAt == null ? null : isoOrNull(item.revokedAt);
  if (item.revokedAt != null && revokedAt === null) return null;
  const scopes = Array.isArray(item.scopes)
    ? item.scopes.filter((scope) => typeof scope === "string" && scope.length > 0)
    : [];
  const name = typeof item.name === "string" ? item.name.trim().slice(0, 64) : "";
  return {
    ...item,
    id: item.id,
    name: name || item.id,
    tokenHash: item.tokenHash,
    tokenPrefix: typeof item.tokenPrefix === "string" && item.tokenPrefix ? item.tokenPrefix : `pk_${item.id.slice(-6)}`,
    createdAt,
    lastSeenAt: isoOrNull(item.lastSeenAt) ?? createdAt,
    revokedAt,
    scopes: scopes.length > 0 ? scopes : [...DEFAULT_SCOPES],
  };
}

function normalizeDevices(loaded) {
  if (!Array.isArray(loaded)) return [];
  const seen = new Set();
  const devices = [];
  for (const item of loaded) {
    const device = normalizeDevice(item);
    if (!device || seen.has(device.id)) continue;
    seen.add(device.id);
    devices.push(device);
  }
  return devices;
}

function hashesEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createDeviceStore({ dataDir, now = () => new Date(), log = console } = {}) {
  if (!dataDir) throw new TypeError("dataDir is required");
  const file = join(dataDir, "devices.json");
  let devices = [];
  let queue = Promise.resolve();

  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function init() {
    return enqueue(async () => {
      const loaded = await readPrivateJson(file, []);
      devices = normalizeDevices(loaded);
      if (!Array.isArray(loaded) || JSON.stringify(loaded) !== JSON.stringify(devices)) {
        log?.warn?.("devices: repaired the device store; malformed records were dropped");
        await writePrivateJson(file, devices);
      }
      return devices;
    });
  }

  async function create(rawName) {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (name.length < 1 || name.length > 64) throw new TypeError("device name must be 1 to 64 characters");
    return enqueue(async () => {
      const token = randomBytes(TOKEN_BYTES).toString("base64url");
      let id;
      do {
        id = `dev_${randomBytes(4).toString("hex")}`;
      } while (devices.some((item) => item.id === id));
      const createdAt = now().toISOString();
      const device = {
        id,
        name,
        tokenHash: `sha256:${hashToken(token).toString("hex")}`,
        tokenPrefix: `pk_${token.slice(0, 6)}`,
        createdAt,
        lastSeenAt: createdAt,
        revokedAt: null,
        scopes: ["read", "approve"],
      };
      const next = structuredClone(devices);
      next.push(device);
      await writePrivateJson(file, next);
      devices = next;
      return { device: structuredClone(device), token };
    });
  }

  async function findActive(rawToken) {
    if (typeof rawToken !== "string" || rawToken === "") return null;
    const hash = `sha256:${hashToken(rawToken).toString("hex")}`;
    return devices.find((item) => hashesEqual(item.tokenHash, hash) && item.revokedAt === null) ?? null;
  }

  function get(id) {
    return devices.find((item) => item.id === id) ?? null;
  }

  function list() {
    return devices.map((item) => structuredClone(item));
  }

  async function touch(id) {
    return enqueue(async () => {
      const device = get(id);
      if (!device || device.revokedAt !== null) return false;
      const at = now();
      if (device.lastSeenAt && at.getTime() - Date.parse(device.lastSeenAt) < LAST_SEEN_MS) return false;
      const next = structuredClone(devices);
      next.find((item) => item.id === id).lastSeenAt = at.toISOString();
      try {
        await writePrivateJson(file, next);
      } catch (error) {
        log?.error?.("devices: could not persist lastSeenAt", error);
        return false;
      }
      devices = next;
      return true;
    });
  }

  async function revoke(id) {
    return enqueue(async () => {
      const device = get(id);
      if (!device || device.revokedAt !== null) return false;
      const next = structuredClone(devices);
      next.find((item) => item.id === id).revokedAt = now().toISOString();
      await writePrivateJson(file, next);
      devices = next;
      return true;
    });
  }

  return {
    init,
    create,
    findActive,
    get,
    list,
    touch,
    revoke,
    activeCount: () => devices.filter((item) => item.revokedAt === null).length,
  };
}
