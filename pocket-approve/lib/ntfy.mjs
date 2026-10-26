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

function cap(value, max) {
  if (typeof value !== "string" || value === "") return "";
  if (value.length <= max) return value;
  return max > 3 ? `${value.slice(0, max - 3)}...` : value.slice(0, max);
}

function capBytes(value, maxBytes) {
  if (typeof value !== "string" || value === "") return "";
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const budget = maxBytes - 3;
  if (budget <= 0) return "";
  let result = "";
  let used = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (used + size > budget) break;
    result += char;
    used += size;
  }
  return `${result}...`;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function detailLines(item) {
  const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const lines = [];
  const add = (label, value) => {
    const clean = text(value);
    if (clean !== "") lines.push(`${label}: ${clean}`);
  };
  add("Command", metadata.command);
  add("Path", metadata.path);
  add("Description", metadata.description);
  add("Tool", item.tool);
  add("Permission", item.permission);
  add("Session", item.sessionID);
  if (Array.isArray(item.patterns) && item.patterns.length > 0) {
    add("Patterns", item.patterns.join(", "));
  }
  return lines;
}

function action(settings, item, label, decision) {
  return {
    action: "http",
    label,
    url: `${settings.baseUrl}/${settings.replyTopic}`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: item.id,
      decision,
      sig: signReply(settings.secret, item.id, decision),
    }),
    clear: true,
  };
}

function joinMessage(summary, details) {
  return details.length === 0 ? summary : `${summary}\n\n${details.join("\n")}`;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

export function fitMessage(input, maxBytes = MAX_MESSAGE_BYTES) {
  if (!input || typeof input !== "object") throw new TypeError("message is required");
  const out = { ...input, actions: Array.isArray(input.actions) ? [...input.actions] : [] };
  const parts = String(input.message ?? "").split("\n");
  const summary = parts.shift() ?? "";
  const details = parts.filter((line) => line !== "");
  out.message = joinMessage(summary, details);
  while (details.length > 1 && byteLength(out) >= maxBytes) {
    details.pop();
    out.message = joinMessage(summary, details);
  }
  while (details.length > 0 && byteLength(out) >= maxBytes) {
    let longest = 0;
    for (let index = 1; index < details.length; index += 1) {
      if (details[index].length > details[longest].length) longest = index;
    }
    if (details[longest].length <= 20) break;
    details[longest] = `${details[longest].slice(0, -20)}...`;
    out.message = joinMessage(summary, details);
  }
  return out;
}

export function buildRequestMessage(item, settings, { allowAlways = true, count = 1 } = {}) {
  if (!item || typeof item.id !== "string" || item.id === "") {
    throw new TypeError("item.id is required");
  }
  const label = text(item.serverLabel) || text(item.serverId) || "OpenCode";
  const title = capBytes(`[${label}] ${text(item.title) || "Permission request"}`, 64);
  const summary = cap(text(item.summary), 140);
  const details = detailLines(item);
  if (count > 1) details.push(`Pending: ${count} requests`);
  const actions = [action(settings, item, "Allow once", "once")];
  if (allowAlways) actions.push(action(settings, item, "Always allow", "always"));
  actions.push(action(settings, item, "Deny", "reject"));
  return fitMessage({
    topic: settings.outTopic,
    title,
    message: joinMessage(summary, details),
    priority: 4,
    tags: ["warning"],
    actions,
  });
}

export function buildTestMessage(settings, id) {
  return fitMessage({
    topic: settings.outTopic,
    title: "[Pocket Approve] Test notification",
    message: "Tap the button to test the reply path. This does not approve a real request.",
    priority: 4,
    tags: ["warning"],
    actions: [action(settings, { id }, "Send test reply", "once")],
  });
}

export function createNdjsonParser(onEvent) {
  if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function");
  let buffer = "";
  function emit(line) {
    if (line.trim() === "") return;
    try {
      onEvent(JSON.parse(line));
    } catch {
      onEvent({ event: "malformed", line });
    }
  }
  return {
    push(chunk) {
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) emit(line);
    },
    flush() {
      if (buffer !== "") emit(buffer);
      buffer = "";
    },
  };
}

function retryAfterMs(response) {
  const value = response?.headers?.get?.("Retry-After");
  if (value === null || value === undefined) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 30000) : null;
}

function delay(sleep, ms) {
  return sleep(ms);
}

export function createNtfy({
  settings,
  dataDir,
  audit,
  fleet,
  allowAlways = true,
  fetchImpl = fetch,
  log = console,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  stallMs = 90000,
} = {}) {
  if (!settings) throw new TypeError("settings is required");
  if (typeof dataDir !== "string" || dataDir === "") throw new TypeError("dataDir is required");
  if (!audit || typeof audit.append !== "function") throw new TypeError("audit is required");
  if (!fleet || typeof fleet.reply !== "function") throw new TypeError("fleet is required");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  let stopped = true;
  let controller = null;
  let loop = null;
  let queue = Promise.resolve();
  let buffer = "";
  const seenEvents = new Set();
  const tests = new Map();
  const testIds = new Set();

  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function publish(message) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetchImpl(settings.baseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(15000),
        });
        if (response.ok) return;
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`ntfy publish failed: HTTP ${response.status}`);
          if (attempt < 2) {
            const wait = retryAfterMs(response) ?? (attempt === 0 ? 250 : 1000);
            await delay(sleep, wait);
            continue;
          }
        }
        throw new Error(`ntfy publish failed: HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
        if (attempt < 2) await delay(sleep, attempt === 0 ? 250 : 1000);
      }
    }
    throw lastError ?? new Error("ntfy publish failed");
  }

  function remember(event) {
    if (typeof event?.id !== "string" || event.id === "") return false;
    if (seenEvents.has(event.id)) return false;
    seenEvents.add(event.id);
    if (seenEvents.size > 500) seenEvents.delete(seenEvents.values().next().value);
    return true;
  }

  async function persistCursor(event) {
    settings.lastEventId = event.id;
    settings.lastEventAt = Number.isFinite(event.time)
      ? new Date(event.time * 1000).toISOString()
      : new Date(now()).toISOString();
    try {
      Object.assign(settings, await saveSettings(dataDir, settings));
    } catch (error) {
      log.error?.(`failed to save ntfy cursor: ${error.message}`);
    }
  }

  async function publishNotice(text) {
    try {
      await publish({
        topic: settings.outTopic,
        title: "Pocket Approve could not apply a decision",
        message: text,
        priority: 4,
        tags: ["warning"],
      });
    } catch (error) {
      log.error?.(`failed to publish ntfy notice: ${error.message}`);
    }
  }

  async function handleReply(reply) {
    if (testIds.has(reply.id)) {
      testIds.delete(reply.id);
      audit.append("test_notification", {
        deviceId: "ntfy",
        requestId: reply.id,
        result: "replied",
      });
      const waiter = tests.get(reply.id);
      if (waiter) {
        tests.delete(reply.id);
        waiter.resolve();
      }
      return;
    }
    let result;
    try {
      result = await fleet.reply(reply.id, reply.decision);
    } catch (error) {
      await publishNotice("Decision did not reach OpenCode. Use the desktop notification or terminal.");
      return;
    }
    const serverId = reply.id.includes(":") ? reply.id.slice(0, reply.id.indexOf(":")) : null;
    audit.append("reply", {
      deviceId: "ntfy",
      serverId,
      requestId: reply.id,
      result: String(result.status),
    });
    if (result.status === 200 || result.status === 404 || result.status === 409) return;
    await publishNotice("Decision did not reach OpenCode. Use the desktop notification or terminal.");
  }

  function handleEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.event === "open" || event.event === "keepalive") return;
    if (event.event !== "message") return;
    const freshEvent = remember(event);
    if (!freshEvent) return;
    enqueue(async () => {
      await persistCursor(event);
      const reply = parseReply(settings, event.message);
      if (!reply) {
        log.error?.("ignored malformed or unsigned ntfy reply");
        return;
      }
      await handleReply(reply);
    });
  }

  async function streamOnce() {
    const url = new URL(`${settings.baseUrl}/${settings.replyTopic}/json`);
    url.searchParams.set("since", settings.lastEventId ?? "10m");
    controller = new AbortController();
    const response = await fetchImpl(url, {
      headers: { Accept: "application/x-ndjson" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`ntfy stream failed: HTTP ${response.status}`);
      error.retryAfter = retryAfterMs(response);
      throw error;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createNdjsonParser((event) => handleEvent(event));
    let watchdog = null;
    const touch = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => controller?.abort(), stallMs);
    };
    touch();
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        touch();
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.flush();
    } finally {
      if (watchdog) clearTimeout(watchdog);
      reader.releaseLock?.();
    }
  }

  async function run() {
    let attempt = 0;
    while (!stopped) {
      try {
        await streamOnce();
        attempt = 0;
      } catch (error) {
        if (stopped) break;
        const base = Math.min(60000, 1000 * 2 ** attempt);
        attempt += 1;
        const wait = error.retryAfter ?? Math.round(base / 2 + Math.random() * (base / 2));
        await delay(sleep, wait);
      }
      if (!stopped) await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return {
    settings,
    async start() {
      if (!stopped) return;
      stopped = false;
      loop = run();
    },
    async stop() {
      stopped = true;
      controller?.abort();
      await loop;
      await queue;
    },
    async publishRequest(request, options = {}) {
      const message = buildRequestMessage(request, settings, { allowAlways, ...options });
      await publish(message);
      return message;
    },
    publishNotice,
    async sendTest() {
      const id = `test:${randomBytes(16).toString("hex")}`;
      testIds.add(id);
      try {
        await publish(buildTestMessage(settings, id));
      } catch (error) {
        testIds.delete(id);
        throw error;
      }
      return { id };
    },
    waitForTest(id, timeoutMs = 120000) {
      testIds.add(id);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          tests.delete(id);
          testIds.delete(id);
          reject(new Error("timed out waiting for test reply"));
        }, timeoutMs);
        tests.set(id, {
          resolve: () => {
            clearTimeout(timer);
            testIds.delete(id);
            resolve();
          },
        });
      });
    },
  };
}
