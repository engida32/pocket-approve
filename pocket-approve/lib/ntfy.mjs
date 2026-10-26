import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { parseOrigin } from "./config-v2.mjs";
import { readPrivateJson, writePrivateJson } from "./store.mjs";

const SETTINGS_FILE = "ntfy.json";
const TOPIC = /^[A-Za-z0-9_-]{1,64}$/;
const DECISIONS = new Set(["once", "always", "reject"]);
const MAX_MESSAGE_BYTES = 4000;

export function ntfySettingsPath(dataDir) {
  return join(dataDir, SETTINGS_FILE);
}

export function newToken() {
  return randomBytes(32).toString("base64url");
}

export function createSettings(now = () => new Date()) {
  return {
    version: 1,
    baseUrl: "https://ntfy.sh",
    outTopic: newToken(),
    replyTopic: newToken(),
    secret: newToken(),
    createdAt: new Date(now()).toISOString(),
    lastEventId: null,
    lastEventAt: null,
  };
}

function topic(value, name) {
  if (typeof value !== "string" || !TOPIC.test(value)) {
    throw new TypeError(`${name} must match ${TOPIC}`);
  }
  return value;
}

function isoOrNull(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO date string or null`);
  }
  return new Date(value).toISOString();
}

export function normalizeSettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("ntfy settings must be an object");
  }
  const baseUrl = parseOrigin(raw.baseUrl ?? "https://ntfy.sh", { name: "ntfy baseUrl" });
  const outTopic = topic(raw.outTopic, "outTopic");
  const replyTopic = topic(raw.replyTopic, "replyTopic");
  if (outTopic === replyTopic) throw new TypeError("outTopic and replyTopic must be different");
  if (typeof raw.secret !== "string" || raw.secret.length < 32) {
    throw new TypeError("ntfy secret must be at least 32 characters");
  }
  if (raw.lastEventId !== null && raw.lastEventId !== undefined && typeof raw.lastEventId !== "string") {
    throw new TypeError("lastEventId must be a string or null");
  }
  const createdAt = isoOrNull(raw.createdAt, "createdAt") ?? new Date().toISOString();
  return {
    version: 1,
    baseUrl,
    outTopic,
    replyTopic,
    secret: raw.secret,
    createdAt,
    lastEventId: raw.lastEventId ?? null,
    lastEventAt: isoOrNull(raw.lastEventAt, "lastEventAt"),
  };
}

export async function loadSettings(dataDir) {
  const raw = await readPrivateJson(ntfySettingsPath(dataDir), null);
  return raw === null ? null : normalizeSettings(raw);
}

export async function saveSettings(dataDir, settings) {
  const normalized = normalizeSettings(settings);
  await writePrivateJson(ntfySettingsPath(dataDir), normalized);
  return normalized;
}

export function rotateSettings(settings, now = () => new Date()) {
  const current = normalizeSettings(settings);
  return {
    ...current,
    outTopic: newToken(),
    replyTopic: newToken(),
    secret: newToken(),
    createdAt: new Date(now()).toISOString(),
    lastEventId: null,
    lastEventAt: null,
  };
}

export function ntfyLink(settings, display = "Pocket Approve") {
  const host = new URL(settings.baseUrl).host;
  return `ntfy://${host}/${settings.outTopic}?display=${encodeURIComponent(display)}`;
}

export function signReply(secret, id, decision) {
  return createHmac("sha256", secret).update(`${id}\n${decision}`).digest("base64url");
}

export function verifyReply(secret, id, decision, sig) {
  if (typeof sig !== "string" || sig === "") return false;
  const expected = Buffer.from(signReply(secret, id, decision));
  const actual = Buffer.from(sig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function parseReply(settings, message) {
  let value;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (typeof value.id !== "string" || value.id === "") return null;
  if (!DECISIONS.has(value.decision)) return null;
  if (!verifyReply(settings.secret, value.id, value.decision, value.sig)) return null;
  return { id: value.id, decision: value.decision };
}
