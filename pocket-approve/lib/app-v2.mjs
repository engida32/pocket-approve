import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./config.mjs";
import { createAuthenticator, expectedOrigin, originAllowed } from "./device-auth.mjs";
import { createRateLimiter } from "./rate-limit.mjs";

const BODY_LIMIT = 16 * 1024;
const VERSION = "2.0.0";
const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const READ_ROUTES = new Set(["/api/pending", "/api/servers", "/api/me", "/api/vapid-public-key"]);
const WRITE_ROUTES = new Set([
  "/api/reply",
  "/api/subscribe",
  "/api/unsubscribe",
  "/api/revoke",
  "/api/test-notification",
]);
const KNOWN_API_PATHS = new Set([
  ...READ_ROUTES,
  ...WRITE_ROUTES,
  "/api/health",
  "/api/pair",
]);
const STATIC = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/pair", "index.html"],
  ["/app.js", "app.js"],
  ["/style.css", "style.css"],
  ["/sw.js", "sw.js"],
  ["/manifest.webmanifest", "manifest.webmanifest"],
  ["/icon.svg", "icon.svg"],
  ["/icon-192.png", "icon-192.png"],
  ["/icon-512.png", "icon-512.png"],
  ["/icon-maskable-512.png", "icon-maskable-512.png"],
  ["/apple-touch-icon.png", "apple-touch-icon.png"],
]);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const CSP = "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'";

export function vapidFingerprint(publicKey) {
  return createHash("sha256").update(String(publicKey)).digest("hex").slice(0, 16);
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

function fail(status, error, extra = {}) {
  return json({ error }, status, extra);
}

function headersFor(path, config) {
  const headers = new Headers({
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
  });
  if (config.publicOrigin?.startsWith("https:") || config.mode === "lan") {
    headers.set("strict-transport-security", "max-age=31536000");
  }
  if (path.startsWith("/api/")) headers.set("cache-control", "no-store");
  if (path === "/sw.js") {
    headers.set("cache-control", "no-cache");
    headers.set("service-worker-allowed", "/");
  }
  return headers;
}

async function readBody(request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > BODY_LIMIT) return { tooLarge: true };
  const buffer = Buffer.from(await request.arrayBuffer());
  if (buffer.length > BODY_LIMIT) return { tooLarge: true };
  if (buffer.length === 0) return { value: null };
  try {
    return { value: JSON.parse(buffer.toString("utf8")) };
  } catch {
    return { invalid: true };
  }
}

function headerView(request) {
  const headers = request?.headers;
  if (!headers) return { headers: {} };
  if (typeof headers.get === "function" && typeof headers.entries === "function") {
    return { headers: Object.fromEntries(headers) };
  }
  return { headers };
}

function rateKey(identity) {
  return identity.device ? `device:${identity.device.id}` : "legacy";
}

function errorMessage(error) {
  if (!error || typeof error !== "object") return "unknown";
  return typeof error.code === "string" ? error.code : "failure";
}

export function createAppV2({
  config,
  fleet,
  push,
  pairing,
  devices,
  notifications,
  audit = null,
  dataDir = DATA_DIR,
  log = console,
} = {}) {
  if (!config || !fleet || !push || !pairing || !devices) {
    throw new TypeError("config, fleet, push, pairing, and devices are required");
  }
  const baseAuthenticator = createAuthenticator({
    devices,
    allowLegacyToken: config.mode === "lan" && config.allowLegacyToken === true,
    legacyToken: config.token,
  });
  const authenticator = {
    authenticate: (request) => baseAuthenticator.authenticate(headerView(request)),
  };
  const rateLimiter = createRateLimiter();

  async function rate(identity, key, limit) {
    return rateLimiter.take(`${rateKey(identity)}:${key}`, limit, 60_000);
  }

  function tooMany(seconds) {
    return fail(429, "rate_limited", { "retry-after": String(seconds) });
  }

  async function serveStatic(path) {
    const name = STATIC.get(path);
    if (!name) return null;
    const root = normalize(PUBLIC);
    const file = normalize(join(root, name));
    if (!file.startsWith(root)) return null;
    let body;
    try {
      body = await readFile(file);
    } catch {
      return null;
    }
    const extension = extname(name);
    const headers = headersFor(path, config);
    headers.set("content-type", TYPES[extension] ?? "application/octet-stream");
    if (path !== "/sw.js") {
      headers.set("cache-control", extension === ".html" ? "no-store" : "public, max-age=86400");
    }
    return new Response(body, { status: 200, headers });
  }

  async function handleApi(request, url, identity) {
    const path = url.pathname;
    if (READ_ROUTES.has(path)) {
      const wait = await rate(identity, "read", 120);
      if (wait) return tooMany(wait);
    }
    if (path === "/api/me") {
      if (identity.legacy) return json({ legacy: true, scopes: ["read", "approve"] });
      return json({
        device: {
          id: identity.device.id,
          name: identity.device.name,
          scopes: identity.device.scopes,
        },
      });
    }
    if (path === "/api/pending") {
      const pending = fleet.pending();
      return json({
        requests: pending.requests,
        servers: pending.servers,
        fetchedAt: pending.fetchedAt,
      });
    }
    if (path === "/api/servers") return json({ servers: fleet.servers() });
    if (path === "/api/vapid-public-key") {
      const publicKey = push.publicKey ?? config.vapid?.publicKey ?? null;
      return json({
        publicKey,
        fingerprint: vapidFingerprint(publicKey ?? ""),
        origin: expectedOrigin(config),
      });
    }
    if (path === "/api/reply") {
      const wait = await rate(identity, "reply", 30);
      if (wait) return tooMany(wait);
      const body = await readBody(request);
      if (body.tooLarge) return fail(413, "body_too_large");
      if (body.invalid || !body.value) return fail(400, "invalid_json");
      const { id, decision } = body.value;
      if (
        typeof id !== "string"
        || id.length === 0
        || id.length > 256
        || !["once", "always", "reject"].includes(decision)
      ) {
        return fail(400, "invalid_reply");
      }
      const result = await fleet.reply(id, decision);
      await audit?.append("reply", {
        deviceId: identity.device?.id ?? "legacy",
        requestId: id,
        result: String(result.status),
      });
      if (result.status === 200) return json({ ok: true, id, decision });
      const error = { error: result.error ?? "reply_failed" };
      if (result.message) error.message = result.message;
      return json(error, result.status);
    }
    if (path === "/api/subscribe") {
      if (identity.legacy) return fail(403, "device_required");
      const wait = await rate(identity, "subscribe", 10);
      if (wait) return tooMany(wait);
      const body = await readBody(request);
      if (body.tooLarge) return fail(413, "body_too_large");
      if (body.invalid || !body.value) return fail(400, "invalid_json");
      const subscription = body.value.subscription;
      if (!subscription || typeof subscription.endpoint !== "string" || !subscription.keys) {
        return fail(400, "invalid_subscription");
      }
      const existing = push
        .listForDevice(identity.device.id)
        .some((item) => item.endpoint === subscription.endpoint);
      try {
        await push.add(subscription, identity.device.id);
      } catch (error) {
        if (error instanceof TypeError) return fail(400, "invalid_subscription");
        const code = typeof error?.code === "string" ? error.code : null;
        if (code) log?.error?.("app-v2: subscribe failed", code);
        else log?.error?.("app-v2: subscribe failed");
        return fail(500, "subscribe_failed");
      }
      await audit?.append("subscribe", { deviceId: identity.device.id, result: "ok" });
      const subscriptions = push.listForDevice(identity.device.id).length;
      return json({ ok: true, subscriptions }, existing ? 200 : 201);
    }
    if (path === "/api/unsubscribe") {
      if (identity.legacy) return fail(403, "device_required");
      const wait = await rate(identity, "subscribe", 10);
      if (wait) return tooMany(wait);
      const body = await readBody(request);
      if (body.tooLarge) return fail(413, "body_too_large");
      if (body.invalid || !body.value || typeof body.value.endpoint !== "string") {
        return fail(400, "invalid_json");
      }
      const endpoint = body.value.endpoint;
      const owned = push.listForDevice(identity.device.id).some((item) => item.endpoint === endpoint);
      if (!owned) return fail(404, "not_found");
      await push.remove(endpoint);
      await audit?.append("unsubscribe", { deviceId: identity.device.id, result: "ok" });
      return new Response(null, { status: 204 });
    }
    if (path === "/api/revoke") {
      if (identity.legacy) return fail(403, "device_required");
      const wait = await rate(identity, "revoke", 5);
      if (wait) return tooMany(wait);
      const body = await readBody(request);
      if (body.tooLarge) return fail(413, "body_too_large");
      const changed = await devices.revoke(identity.device.id);
      if (!changed) return fail(404, "device_not_found");
      let subscriptionsRemoved = 0;
      try {
        subscriptionsRemoved = await push.removeByDevice(identity.device.id);
      } catch (error) {
        log?.error?.(`app: could not remove push subscriptions for ${identity.device.id}`, error);
        return fail(500, "revoke_failed");
      }
      await audit?.append("revoke", {
        deviceId: identity.device.id,
        result: `self:${subscriptionsRemoved}`,
      });
      return json({ ok: true, id: identity.device.id, subscriptionsRemoved });
    }
    if (path === "/api/test-notification") {
      const wait = await rate(identity, "test", 10);
      if (wait) return tooMany(wait);
      const body = await readBody(request);
      if (body.tooLarge) return fail(413, "body_too_large");
      const result = await notifications.sendTest(identity.device?.id ?? null);
      return json(result);
    }
    return fail(404, "not_found");
  }

  async function route(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const view = headerView(request);

    if (path.startsWith("/api/") && !KNOWN_API_PATHS.has(path)) return fail(404, "not_found");

    if (path === "/api/health") {
      if (request.method !== "GET") return fail(405, "method_not_allowed", { allow: "GET" });
      return json({ ok: true, version: VERSION, mode: config.mode, time: new Date().toISOString() });
    }
    if (path === "/api/pair") {
      if (request.method !== "POST") return fail(405, "method_not_allowed", { allow: "POST" });
      if (!originAllowed(view, config)) return fail(403, "origin_forbidden");
      const wait = rateLimiter.take("pair:global", 10, 60_000);
      if (wait) return tooMany(wait);
      const body = await readBody(request);
      if (body.tooLarge) return fail(413, "body_too_large");
      if (body.invalid || !body.value) return fail(400, "invalid_json");
      const { code, deviceName } = body.value;
      if (typeof code !== "string" || typeof deviceName !== "string") {
        return fail(400, "invalid_pair_request");
      }
      const name = deviceName.trim();
      if (name.length < 1 || name.length > 64) return fail(400, "invalid_device_name");
      let created = null;
      let result;
      try {
        result = await pairing.redeem(code, async () => {
          created = await devices.create(name);
        });
      } catch (error) {
        log?.error?.("app-v2: device create failed", errorMessage(error));
        return fail(500, "pair_failed");
      }
      if (!result.ok) {
        await audit?.append("pair_failed", { result: result.reason });
        if (result.reason === "expired" || result.reason === "missing") {
          return fail(410, "pairing_code_expired");
        }
        if (result.reason === "locked") return fail(429, "pairing_code_locked");
        return fail(401, "invalid_pairing_code");
      }
      if (!created) return fail(500, "pair_failed");
      await audit?.append("pair", { deviceId: created.device.id, result: "ok" });
      return json(
        {
          device: { id: created.device.id, name: created.device.name },
          token: created.token,
          origin: expectedOrigin(config),
        },
        201,
      );
    }

    const staticResponse = await serveStatic(path);
    if (staticResponse) return staticResponse;
    if (!path.startsWith("/api/")) return fail(404, "not_found");

    const identity = await authenticator.authenticate(request);
    if (!identity) {
      const wait = rateLimiter.take("auth:global", 60, 60_000);
      if (wait === 0) await audit?.append("auth_failed", { result: "invalid_token" });
      return fail(401, "unauthorized");
    }

    if (request.method !== "GET" && request.method !== "POST") {
      return fail(405, "method_not_allowed", { allow: READ_ROUTES.has(path) ? "GET" : "POST" });
    }
    if (request.method === "GET" && WRITE_ROUTES.has(path)) {
      return fail(405, "method_not_allowed", { allow: "POST" });
    }
    if (request.method === "POST" && READ_ROUTES.has(path)) {
      return fail(405, "method_not_allowed", { allow: "GET" });
    }
    if (request.method === "POST" && !originAllowed(view, config)) {
      return fail(403, "origin_forbidden");
    }
    return handleApi(request, url, identity);
  }

  async function handler(request) {
    let response;
    try {
      response = await route(request);
    } catch {
      log?.error?.("app-v2: request failed");
      response = fail(500, "internal_error");
    }
    const common = headersFor(new URL(request.url).pathname, config);
    for (const [key, value] of common) response.headers.set(key, value);
    return response;
  }

  return { handler, authenticator, rateLimiter };
}
