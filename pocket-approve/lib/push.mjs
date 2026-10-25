import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import webpush from "web-push";

const STORE_NAME = "subscriptions.json";
const PRUNE_STATUS_CODES = new Set([404, 410]);
const DEVICE_ID_PATTERN = /^dev_[a-z0-9]{1,32}$/;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function normalizeTracking(entry, fallbackCreatedAt) {
  const createdAt =
    entry.createdAt === undefined || entry.createdAt === null
      ? fallbackCreatedAt
      : entry.createdAt;
  if (!isTimestamp(createdAt)) {
    throw new TypeError("subscription.createdAt must be a valid timestamp");
  }

  const lastSuccessAt = entry.lastSuccessAt ?? null;
  if (lastSuccessAt !== null && !isTimestamp(lastSuccessAt)) {
    throw new TypeError(
      "subscription.lastSuccessAt must be a valid timestamp or null",
    );
  }

  const lastFailureAt = entry.lastFailureAt ?? null;
  if (lastFailureAt !== null && !isTimestamp(lastFailureAt)) {
    throw new TypeError(
      "subscription.lastFailureAt must be a valid timestamp or null",
    );
  }

  const failures = entry.failures === undefined ? 0 : entry.failures;
  if (!Number.isInteger(failures) || failures < 0) {
    throw new TypeError("subscription.failures must be a non-negative integer");
  }

  return { createdAt, lastSuccessAt, lastFailureAt, failures };
}

function freshTracking(at = new Date().toISOString()) {
  return { createdAt: at, lastSuccessAt: null, lastFailureAt: null, failures: 0 };
}

function assertDeviceId(deviceId) {
  if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new TypeError("deviceId must be a device id");
  }
}

function normalizeSubscription(subscription, deviceId = null) {
  if (!isObject(subscription)) {
    throw new TypeError("subscription must be an object");
  }
  const { endpoint } = subscription;
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new TypeError("subscription.endpoint must be a non-empty string");
  }
  try {
    new URL(endpoint);
  } catch {
    throw new TypeError("subscription.endpoint must be a valid URL");
  }

  const normalized = { endpoint };

  if (deviceId !== null) {
    assertDeviceId(deviceId);
    normalized.deviceId = deviceId;
  }

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

function validateSubscription(subscription) {
  let url;
  try {
    url = new URL(subscription.endpoint);
  } catch {
    throw new TypeError("subscription.endpoint must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new TypeError("subscription.endpoint must be an https URL");
  }
  for (const name of ["p256dh", "auth"]) {
    const value = subscription.keys?.[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`subscription.keys.${name} must be a non-empty string`);
    }
  }
  if (subscription.deviceId !== undefined) {
    assertDeviceId(subscription.deviceId);
  }
}

function mergeSubscription(existing, incoming) {
  const merged = { endpoint: incoming.endpoint };
  const deviceId = incoming.deviceId ?? existing.deviceId;
  if (deviceId !== undefined) merged.deviceId = deviceId;
  const keys = { ...(existing.keys ?? {}), ...(incoming.keys ?? {}) };
  if (Object.keys(keys).length > 0) merged.keys = keys;
  const expirationTime = incoming.expirationTime ?? existing.expirationTime;
  if (expirationTime !== undefined) merged.expirationTime = expirationTime;
  return merged;
}

function earliestTimestamp(a, b) {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function latestTimestamp(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function mergeLoadedSubscription(existing, incoming) {
  const merged = mergeSubscription(existing, incoming);
  merged.createdAt = earliestTimestamp(existing.createdAt, incoming.createdAt);
  merged.lastSuccessAt = latestTimestamp(existing.lastSuccessAt, incoming.lastSuccessAt);
  merged.lastFailureAt = latestTimestamp(existing.lastFailureAt, incoming.lastFailureAt);
  merged.failures = Math.max(existing.failures, incoming.failures);
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
  if (vapid !== null && vapid !== undefined) {
    if (
      !isObject(vapid) ||
      typeof vapid.subject !== "string" ||
      vapid.subject.trim().length === 0
    ) {
      throw new TypeError("vapid.subject must be a non-empty string");
    }
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

  async function persistDeliveryState() {
    try {
      await persist();
    } catch (error) {
      logError("push: failed to persist subscriptions after send", error);
    }
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

    const loadedAt = new Date().toISOString();
    const loaded = new Map();
    for (const [index, entry] of parsed.entries()) {
      let subscription;
      try {
        const owner =
          isObject(entry) && entry.deviceId !== undefined ? entry.deviceId : null;
        subscription = normalizeSubscription(entry, owner);
        Object.assign(subscription, normalizeTracking(entry, loadedAt));
      } catch (error) {
        throw new Error(
          `Invalid subscription at ${storePath}[${index}]: ${error.message}`,
        );
      }
      const existing = loaded.get(subscription.endpoint);
      loaded.set(
        subscription.endpoint,
        existing ? mergeLoadedSubscription(existing, subscription) : subscription,
      );
    }
    subscriptions = [];
    for (const subscription of loaded.values()) {
      try {
        validateSubscription(subscription);
      } catch (error) {
        throw new Error(
          `Invalid subscription for ${subscription.endpoint} in ${storePath}: ${error.message}`,
        );
      }
      subscriptions.push(subscription);
    }
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

  function listForDevice(deviceId) {
    if (deviceId !== null) assertDeviceId(deviceId);
    return subscriptions
      .filter((item) =>
        deviceId === null ? item.deviceId === undefined : item.deviceId === deviceId,
      )
      .map(clone);
  }

  async function add(subscription, deviceId = null) {
    const normalized = normalizeSubscription(subscription, deviceId);
    await init();
    const index = subscriptions.findIndex(
      (stored) => stored.endpoint === normalized.endpoint,
    );
    let stored;
    if (index === -1) {
      stored = { ...normalized, ...freshTracking() };
    } else {
      const existing = subscriptions[index];
      stored = {
        ...mergeSubscription(existing, normalized),
        ...normalizeTracking(existing, new Date().toISOString()),
      };
    }
    validateSubscription(stored);
    if (index === -1) {
      subscriptions.push(stored);
    } else {
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

  async function removeByDevice(deviceId) {
    assertDeviceId(deviceId);
    await init();
    const before = subscriptions.length;
    subscriptions = subscriptions.filter((item) => item.deviceId !== deviceId);
    const removed = before - subscriptions.length;
    if (removed > 0) await persist();
    return removed;
  }

  async function send(payload = {}, { deviceId = null, options = null } = {}) {
    await init();
    if (deviceId !== null) assertDeviceId(deviceId);
    if (options !== null && !isObject(options)) {
      throw new TypeError("options must be an object or null");
    }

    const body = JSON.stringify(payload);
    const mergedOptions = options ? { ...options } : {};
    if (vapidDetails) mergedOptions.vapidDetails = vapidDetails;
    const requestOptions =
      Object.keys(mergedOptions).length > 0 ? mergedOptions : undefined;
    const result = { sent: 0, failed: 0, removed: 0 };
    let changed = false;
    const targets =
      deviceId === null
        ? subscriptions.filter((item) => item.deviceId === undefined)
        : subscriptions.filter((item) => item.deviceId === deviceId);

    for (const subscription of [...targets]) {
      try {
        await sendFn(subscription, body, requestOptions);
        result.sent += 1;
        subscription.lastSuccessAt = new Date().toISOString();
        subscription.failures = 0;
        changed = true;
      } catch (error) {
        const statusCode = Number(error?.statusCode);
        if (PRUNE_STATUS_CODES.has(statusCode)) {
          const index = subscriptions.findIndex(
            (stored) => stored.endpoint === subscription.endpoint,
          );
          if (index !== -1) {
            subscriptions.splice(index, 1);
            changed = true;
            result.removed += 1;
          }
          continue;
        }
        result.failed += 1;
        subscription.lastFailureAt = new Date().toISOString();
        subscription.failures = (subscription.failures ?? 0) + 1;
        changed = true;
        logError(`push: failed to send to ${subscription.endpoint}`, error);
      }
    }

    if (changed) await persistDeliveryState();
    return result;
  }

  return {
    init,
    publicKey,
    list,
    listForDevice,
    add,
    remove,
    removeByDevice,
    send,
  };
}
