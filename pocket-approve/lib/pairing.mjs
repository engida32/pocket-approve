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

export function createPairing({ dataDir, secret, ttlMs = 600_000, now = () => new Date() } = {}) {
  if (!dataDir) throw new TypeError("dataDir is required");
  if (typeof secret !== "string" || secret.length < 20) throw new TypeError("pairing secret is required");
  const file = join(dataDir, FILE);
  let record = null;
  let retired = null;
  let queue = Promise.resolve();

  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  const persist = async () => {
    await writePrivateJson(file, record);
  };

  const init = () =>
    enqueue(async () => {
      record = await readPrivateJson(file, null);
      retired = null;
    });

  const open = (rawLabel = "Device") =>
    enqueue(async () => {
      const label = typeof rawLabel === "string" ? rawLabel.trim().slice(0, 64) : "Device";
      if (!label) throw new TypeError("pairing label is required");
      if (record && typeof record.hash === "string" && typeof record.salt === "string") {
        retired = { hash: record.hash, salt: record.salt };
      }
      const code = makeCode();
      const salt = randomBytes(16).toString("base64url");
      const createdAt = now();
      record = {
        hash: hash(secret, salt, code),
        salt,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
        attempts: 0,
        label,
      };
      await persist();
      return { code, expiresAt: record.expiresAt, label };
    });

  const redeem = (code, handler) =>
    enqueue(async () => {
      if (!record || record.attempts >= MAX_ATTEMPTS) {
        if (record && record.attempts >= MAX_ATTEMPTS) {
          record = null;
          await persist().catch(() => {});
          return { ok: false, reason: "locked" };
        }
        return { ok: false, reason: "missing" };
      }
      if (now().getTime() > Date.parse(record.expiresAt)) {
        record = null;
        await persist().catch(() => {});
        return { ok: false, reason: "expired" };
      }
      const normalized = normalizePairCode(code);
      if (retired && normalized.length === 8 && equal(hash(secret, retired.salt, code), retired.hash)) {
        return { ok: false, reason: "missing" };
      }
      if (normalized.length !== 8 || !equal(hash(secret, record.salt, code), record.hash)) {
        record.attempts += 1;
        await persist();
        return { ok: false, reason: "bad_code" };
      }
      const label = record.label;
      await handler({ label });
      record = null;
      retired = null;
      await persist();
      return { ok: true, label };
    });

  return { init, open, redeem };
}
