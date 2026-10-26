import { createClient } from "./opencode.mjs";
import { createOpenCodeSource } from "./adapters/opencode.mjs";
import { namespacedId, parseNamespacedId } from "./ids.mjs";

const MAX_PER_SERVER = 500;
const MAX_TOTAL = 2000;
const BACKOFF_MS = [3000, 6000, 12000, 30000];
const DECISIONS = new Set(["once", "always", "reject"]);

function jitter(ms, random = Math.random) {
  return Math.round(ms * (0.85 + random() * 0.3));
}

function errorCode(error) {
  if (error?.code === "UPSTREAM_TIMEOUT" || error?.name === "AbortError") return "timeout";
  const status = Number(error?.status);
  if (status === 401 || status === 403) return "unauthorized";
  if (status >= 500 && status <= 599) return `http_${status}`;
  if (status >= 400) return "invalid_response";
  return "offline";
}

function publicRequest(link, raw, firstSeen) {
  return {
    id: namespacedId(link.id, raw.id),
    serverId: link.id,
    serverLabel: link.label,
    sessionID: raw.sessionID,
    permission: raw.permission,
    patterns: raw.patterns,
    always: raw.always ?? [],
    tool: raw.tool ?? null,
    metadata: raw.metadata,
    title: raw.title,
    summary: raw.summary,
    firstSeen,
  };
}

export function createFleet({
  config,
  onChange = () => {},
  log = console,
  now = Date.now,
  random = Math.random,
} = {}) {
  if (!config || !Array.isArray(config.servers)) throw new TypeError("fleet config is required");
  const links = [];
  let started = false;
  let stopped = false;
  let lifecycle = 0;

  function makeLink(server) {
    const link = {
      id: server.id,
      label: server.label,
      server,
      cache: new Map(),
      health: {
        id: server.id,
        label: server.label,
        ok: false,
        lastSuccess: null,
        lastError: null,
        latencyMs: null,
        consecutiveFailures: 0,
      },
      client: null,
      source: null,
      timer: null,
      inFlight: null,
      replyInFlight: new Set(),
      failures: 0,
      version: 0,
      replied: new Map(),
      configError: null,
      disabled: server.enabled === false,
    };
    if (link.disabled) {
      link.health.lastError = "disabled";
      return link;
    }
    let password = server.password;
    if (server.passwordEnv) {
      password = process.env[server.passwordEnv] ?? null;
      if (!password) {
        link.configError = "config_error";
        link.health.lastError = "config_error";
        return link;
      }
    }
    link.client = createClient({
      baseUrl: server.url,
      username: server.username,
      password,
      timeoutMs: 5000,
      directory: server.directory,
    });
    link.source = createOpenCodeSource(link.client);
    return link;
  }

  function forget(link, rawId) {
    link.cache.delete(rawId);
    link.replied.set(rawId, ++link.version);
  }

  function schedule(link, token) {
    if (link.disabled || link.configError) return;
    if (token !== lifecycle || !started || stopped) return;
    const base = link.failures > 0
      ? BACKOFF_MS[Math.min(link.failures - 1, BACKOFF_MS.length - 1)]
      : config.pollIntervalMs;
    link.timer = setTimeout(() => {
      link.timer = null;
      poll(link).finally(() => schedule(link, token));
    }, jitter(base, random));
    link.timer.unref?.();
  }

  async function poll(link) {
    if (link.disabled || link.configError) return false;
    if (link.inFlight) return link.inFlight;
    const startedAt = now();
    const versionAtStart = link.version;
    link.inFlight = (async () => {
      try {
        const listed = await link.source.list();
        if (!Array.isArray(listed)) throw new Error("invalid list response");
        const next = new Map();
        for (const raw of listed) {
          if (!raw || typeof raw.id !== "string" || raw.id === "") continue;
          if ((link.replied.get(raw.id) ?? 0) > versionAtStart) continue;
          const existing = link.cache.get(raw.id);
          next.set(raw.id, { raw, firstSeen: existing?.firstSeen ?? new Date(startedAt).toISOString() });
        }
        while (next.size > MAX_PER_SERVER) next.delete(next.keys().next().value);
        link.cache = next;
        for (const [rawId, version] of link.replied) {
          if (version <= versionAtStart) link.replied.delete(rawId);
        }
        link.failures = 0;
        link.health.ok = true;
        link.health.lastSuccess = new Date(now()).toISOString();
        link.health.lastError = null;
        link.health.latencyMs = now() - startedAt;
        link.health.consecutiveFailures = 0;
        Promise.resolve(onChange(link)).catch((error) => {
          try {
            log?.error?.(`fleet: change hook failed for ${link.id}`, error);
          } catch {}
        });
        return true;
      } catch (error) {
        link.failures += 1;
        link.health.ok = false;
        link.health.lastError = errorCode(error);
        link.health.consecutiveFailures = link.failures;
        link.health.latencyMs = now() - startedAt;
        try {
          log?.error?.(`fleet: poll failed for ${link.id}`, link.health.lastError);
        } catch {}
        return false;
      } finally {
        link.inFlight = null;
      }
    })();
    return link.inFlight;
  }

  async function init({ quiet = false } = {}) {
    if (links.length > 0) return links;
    for (const server of config.servers) links.push(makeLink(server));
    if (!quiet) {
      try {
        log?.log?.(`fleet: ${links.length} configured server(s)`);
      } catch {}
    }
    return links;
  }

  async function refreshAll() {
    await Promise.all(links.map(poll));
  }

  function start() {
    if (links.length === 0) return;
    if (started) return;
    started = true;
    stopped = false;
    const token = ++lifecycle;
    for (const link of links) {
      if (link.disabled || link.configError) continue;
      poll(link).finally(() => schedule(link, token));
    }
  }

  async function stop() {
    stopped = true;
    started = false;
    lifecycle += 1;
    for (const link of links) {
      if (link.timer) clearTimeout(link.timer);
      link.timer = null;
    }
    await Promise.allSettled(links.map((link) => link.inFlight).filter(Boolean));
  }

  function servers() {
    return links.map((link) => ({ ...link.health, pending: link.cache.size }));
  }

  function pending() {
    const requests = [];
    for (const link of links) {
      for (const { raw, firstSeen } of link.cache.values()) {
        requests.push(publicRequest(link, raw, firstSeen));
      }
    }
    requests.sort((a, b) => {
      const byTime = Date.parse(b.firstSeen) - Date.parse(a.firstSeen);
      return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
    });
    const bounded = requests.slice(0, MAX_TOTAL);
    if (requests.length > MAX_TOTAL) {
      try {
        log?.warn?.(`fleet: pending capped at ${MAX_TOTAL} across all servers`);
      } catch {}
    }
    return { requests: bounded, servers: servers(), fetchedAt: new Date(now()).toISOString() };
  }

  async function reply(publicId, decision) {
    const parsed = parseNamespacedId(publicId);
    if (!parsed) return { status: 404, error: "unknown_request" };
    if (!DECISIONS.has(decision)) return { status: 400, error: "bad_decision" };
    const link = links.find((item) => item.id === parsed.serverId);
    if (!link || !link.cache.has(parsed.rawId)) return { status: 404, error: "unknown_request" };
    if (link.replyInFlight.has(parsed.rawId)) return { status: 409, error: "already_in_flight" };
    link.replyInFlight.add(parsed.rawId);
    try {
      await link.source.reply(parsed.rawId, decision);
      forget(link, parsed.rawId);
      return { status: 200 };
    } catch (error) {
      const status = Number(error?.status);
      if (status === 404 || status === 409) {
        forget(link, parsed.rawId);
        return { status, error: status === 404 ? "not_found" : "conflict" };
      }
      if (status === 401 || status === 403) {
        return { status: 502, error: "server_unauthorized", message: "Server rejected its credentials." };
      }
      return { status: 502, error: "server_unavailable", message: "Server did not accept the reply." };
    } finally {
      link.replyInFlight.delete(parsed.rawId);
    }
  }

  return {
    init,
    refreshAll,
    start,
    stop,
    pending,
    servers,
    reply,
    serverCount: () => links.filter((item) => !item.disabled).length,
  };
}
