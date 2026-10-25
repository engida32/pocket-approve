import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import webpush from "web-push";

const STORE_NAME = "subscriptions.json";
const PRUNE_STATUS_CODES = new Set([404, 410]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSubscription(subscription) {
  if (!isObject(subscription)) {
    throw new TypeError("subscription must be an object");
  }
  const { endpoint } = subscription;
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new TypeError("subscription.endpoint must be a non-empty string");
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TypeError("subscription.endpoint must be a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("subscription.endpoint must be an http(s) URL");
  }

  const normalized = { endpoint };

  if (subscription.keys !== undefined) {
    if (!isObject(subscription.keys)) {
      throw new TypeError("subscription.keys must be an object");
    }
    const keys = {};
    for (const name of ["p256dh", "auth"]) {
      const value = subscription.keys[name];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`subscription.keys.${name} must be a non-empty string`);
      }
      keys[name] = value;
    }
    if (Object.keys(keys).length > 0) normalized.keys = keys;
  }

  if (subscription.expirationTime !== undefined && subscription.expirationTime !== null) {
    if (
      typeof subscription.expirationTime !== "number" ||
      !Number.isFinite(subscription.expirationTime)
    ) {
      throw new TypeError("subscription.expirationTime must be a finite number");
    }
    normalized.expirationTime = subscription.expirationTime;
  }

  return normalized;
}

function mergeSubscription(existing, incoming) {
  const merged = { endpoint: incoming.endpoint };
  const keys = { ...(existing.keys ?? {}), ...(incoming.keys ?? {}) };
  if (Object.keys(keys).length > 0) merged.keys = keys;
  const expirationTime = incoming.expirationTime ?? existing.expirationTime;
  if (expirationTime !== undefined) merged.expirationTime = expirationTime;
  return merged;
}

export function createPush({
  dataDir,
  vapid,
  sendFn = webpush.sendNotification,
  log = console,
} = {}) {
  if (typeof dataDir !== "string" || dataDir.length === 0) {
    throw new TypeError("dataDir must be a non-empty string");
  }
  if (typeof sendFn !== "function") {
    throw new TypeError("sendFn must be a function");
  }

  const storePath = join(dataDir, STORE_NAME);
  const publicKey =
    vapid && typeof vapid.publicKey === "string" ? vapid.publicKey : null;
  const vapidDetails =
    vapid &&
    typeof vapid.subject === "string" &&
    typeof vapid.publicKey === "string" &&
    typeof vapid.privateKey === "string"
      ? {
          subject: vapid.subject,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        }
      : undefined;

  let subscriptions = [];
  let initialized = null;
  let writeChain = Promise.resolve();
  let tempCounter = 0;

  function logError(message, error) {
    try {
      if (log && typeof log.error === "function") log.error(message, error);
    } catch {}
  }

  function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
  }

  async function persist() {
    const snapshot = JSON.stringify(subscriptions, null, 2) + "\n";
    const write = writeChain.then(async () => {
      tempCounter += 1;
      const tempPath = `${storePath}.${process.pid}.${tempCounter}.tmp`;
      await writeFile(tempPath, snapshot, { mode: 0o600 });
      await chmod(tempPath, 0o600);
      await rename(tempPath, storePath);
      await chmod(storePath, 0o600);
    });
    writeChain = write.catch(() => {});
    return write;
  }

  async function load() {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });

    let raw;
    try {
      raw = await readFile(storePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        subscriptions = [];
        return;
      }
      throw error;
    }

    await chmod(storePath, 0o600);

    if (raw.trim() === "") {
      subscriptions = [];
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON in ${storePath}. Remove it to start fresh.`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid subscriptions in ${storePath}: expected an array`);
    }

    const loaded = new Map();
    for (const [index, entry] of parsed.entries()) {
      let subscription;
      try {
        subscription = normalizeSubscription(entry);
      } catch (error) {
        throw new Error(
          `Invalid subscription at ${storePath}[${index}]: ${error.message}`,
        );
      }
      const existing = loaded.get(subscription.endpoint);
      loaded.set(
        subscription.endpoint,
        existing ? mergeSubscription(existing, subscription) : subscription,
      );
    }
    subscriptions = [...loaded.values()];
  }

  function init() {
    if (!initialized) {
      initialized = load().catch((error) => {
        initialized = null;
        throw error;
      });
    }
    return initialized;
  }

  function list() {
    return subscriptions.map(clone);
  }

  async function add(subscription) {
    const normalized = normalizeSubscription(subscription);
    await init();
    const index = subscriptions.findIndex(
      (stored) => stored.endpoint === normalized.endpoint,
    );
    let stored = normalized;
    if (index === -1) {
      subscriptions.push(stored);
    } else {
      stored = mergeSubscription(subscriptions[index], normalized);
      subscriptions[index] = stored;
    }
    await persist();
    return clone(stored);
  }

  async function remove(endpoint) {
    await init();
    const index = subscriptions.findIndex((stored) => stored.endpoint === endpoint);
    if (index === -1) return false;
    subscriptions.splice(index, 1);
    await persist();
    return true;
  }

  async function send(payload = {}) {
    await init();
    const body = JSON.stringify(payload);
    const options = vapidDetails ? { vapidDetails } : undefined;
    const result = { sent: 0, failed: 0, removed: 0 };
    let removedAny = false;

    for (const subscription of [...subscriptions]) {
      try {
        await sendFn(subscription, body, options);
        result.sent += 1;
      } catch (error) {
        const statusCode = Number(error?.statusCode);
        if (PRUNE_STATUS_CODES.has(statusCode)) {
          const index = subscriptions.findIndex(
            (stored) => stored.endpoint === subscription.endpoint,
          );
          if (index !== -1) {
            subscriptions.splice(index, 1);
            removedAny = true;
            result.removed += 1;
          }
          continue;
        }
        result.failed += 1;
        logError(`push: failed to send to ${subscription.endpoint}`, error);
      }
    }

    if (removedAny) await persist();
    return result;
  }

  return { init, publicKey, list, add, remove, send };
}
