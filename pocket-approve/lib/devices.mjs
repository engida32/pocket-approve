import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { hashToken } from "./auth.mjs";
import { readPrivateJson, writePrivateJson } from "./store.mjs";

const TOKEN_BYTES = 32;
const LAST_SEEN_MS = 60_000;

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
      devices = Array.isArray(loaded) ? loaded.filter((item) => item && typeof item.id === "string") : [];
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
    return devices.find((item) => item.tokenHash === hash && item.revokedAt === null) ?? null;
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
