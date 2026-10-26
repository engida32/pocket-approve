import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "./store.mjs";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_ATTEMPTS = 5;
const FILE = "pairing.json";

export function generatePairingSecret() {
  return randomBytes(32).toString("base64url");
}

export function normalizePairCode(input) {
  if (typeof input !== "string") return "";
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function formatPairCode(code) {
  const value = normalizePairCode(code);
  return value.length === 8 ? `${value.slice(0, 4)}-${value.slice(4)}` : value;
}

function makeCode() {
  const bytes = randomBytes(8);
  let value = "";
  for (const byte of bytes) value += ALPHABET[byte % ALPHABET.length];
  return formatPairCode(value);
}

function hash(secret, salt, code) {
  return createHmac("sha256", secret).update(salt).update(normalizePairCode(code)).digest("base64url");
}

function equal(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.hash !== "string" || value.hash === "") return null;
  if (typeof value.salt !== "string" || value.salt === "") return null;
  if (!Number.isInteger(value.attempts) || value.attempts < 0) return null;
  if (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) return null;
  if (typeof value.label !== "string") return null;
  const state = value.state === undefined ? "active" : value.state;
  if (state !== "active" && state !== "consumed") return null;
  return { ...value, state };
}

export function createPairing({ dataDir, secret, ttlMs = 600_000, now = () => new Date() } = {}) {
  if (!dataDir) throw new TypeError("dataDir is required");
  if (typeof secret !== "string" || secret.length < 20) throw new TypeError("pairing secret is required");
  const file = join(dataDir, FILE);
  let record = null;
  let retired = null;
  let locked = false;
  let queue = Promise.resolve();

  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  const persist = (value) => writePrivateJson(file, value);

  const clear = async () => {
    try {
      await persist(null);
      record = null;
    } catch {}
  };

  const init = () =>
    enqueue(async () => {
      const loaded = validRecord(await readPrivateJson(file, null));
      retired = null;
      locked = false;
      if (!loaded) {
        record = null;
        return;
      }
      if (loaded.state === "consumed") {
        record = null;
        locked = true;
        try {
          await persist(null);
        } catch {}
        return;
      }
      record = loaded;
    });

  const open = (rawLabel = "Device") =>
    enqueue(async () => {
      const text = typeof rawLabel === "string" ? rawLabel.trim() : "Device";
      const label = [...text].slice(0, 64).join("");
      if (!label) throw new TypeError("pairing label is required");
      const nextRetired =
        record && record.state !== "consumed" && typeof record.hash === "string" && typeof record.salt === "string"
          ? { hash: record.hash, salt: record.salt }
          : retired;
      const code = makeCode();
      const salt = randomBytes(16).toString("base64url");
      const createdAt = now();
      const next = {
        hash: hash(secret, salt, code),
        salt,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
        attempts: 0,
        label,
        state: "active",
      };
      await persist(next);
      record = next;
      retired = nextRetired;
      locked = false;
      return { code, expiresAt: next.expiresAt, label };
    });

  const redeem = (code, handler) =>
    enqueue(async () => {
      if (locked) {
        locked = false;
        return { ok: false, reason: "locked" };
      }
      if (record && record.state === "consumed") {
        await clear();
        return { ok: false, reason: "locked" };
      }
      if (!record || record.attempts >= MAX_ATTEMPTS) {
        if (record && record.attempts >= MAX_ATTEMPTS) {
          await clear();
          return { ok: false, reason: "locked" };
        }
        return { ok: false, reason: "missing" };
      }
      if (now().getTime() > Date.parse(record.expiresAt)) {
        await clear();
        return { ok: false, reason: "expired" };
      }
      const normalized = normalizePairCode(code);
      if (retired && normalized.length === 8 && equal(hash(secret, retired.salt, code), retired.hash)) {
        return { ok: false, reason: "missing" };
      }
      if (normalized.length !== 8) {
        return { ok: false, reason: "bad_code" };
      }
      if (!equal(hash(secret, record.salt, code), record.hash)) {
        const next = { ...record, attempts: record.attempts + 1 };
        try {
          await persist(next);
        } catch {
          return { ok: false, reason: "bad_code" };
        }
        record = next;
        return { ok: false, reason: "bad_code" };
      }
      const label = record.label;
      const consumed = { ...record, state: "consumed" };
      await persist(consumed);
      record = consumed;
      try {
        await handler({ label });
      } catch (error) {
        const restored = { ...consumed, state: "active" };
        try {
          await persist(restored);
          record = restored;
        } catch {}
        throw error;
      }
      try {
        await persist(null);
        record = null;
      } catch {}
      retired = null;
      return { ok: true, label };
    });

  return { init, open, redeem };
}
