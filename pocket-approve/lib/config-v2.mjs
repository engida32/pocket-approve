import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { DATA_DIR } from "./config.mjs";

export const SCHEMA_VERSION = 2;
export const MAX_SERVERS = 50;
export const SERVER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function resolveDataDir() {
  return process.env.POCKET_APPROVE_DATA
    ? resolve(process.env.POCKET_APPROVE_DATA)
    : DATA_DIR;
}

function configPath(dataDir) {
  return join(dataDir, "config.json");
}

export let CONFIG_V2_PATH = configPath(resolveDataDir());

function activeDataDir() {
  const dataDir = resolveDataDir();
  CONFIG_V2_PATH = configPath(dataDir);
  return dataDir;
}

function bareHost(host) {
  if (typeof host !== "string") return host;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  return LOOPBACK.has(bareHost(host));
}

function validPort(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`config.${name} must be an integer from 1 to 65535`);
  }
  return value;
}

function validLanHost(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("lan mode host must be a specific address");
  }
  let host = value;
  if (host.startsWith("[") || host.endsWith("]")) {
    if (!host.startsWith("[") || !host.endsWith("]")) {
      throw new Error("lan mode host must not include a port");
    }
    host = host.slice(1, -1);
    if (isIP(host) !== 6) throw new Error("lan mode host must be a valid IPv6 address");
  } else if (isIP(host) === 0) {
    if (host.includes(":")) throw new Error("lan mode host must not include a port");
    if (/[\s/]/.test(host)) throw new Error("lan mode host must be a specific address");
  }
  const wildcard = host === "0.0.0.0"
    || host === "::"
    || (isIP(host) === 6 && new URL(`http://[${host}]`).hostname === "[::]");
  if (wildcard) throw new Error("lan mode host must be a specific address");
  return host;
}

function originHost(host) {
  return isIP(host) === 6 ? `[${host}]` : host;
}

export function parseOrigin(value, { name = "url", allowHttp = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new Error(`${name} must use https`);
  }
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an origin only`);
  }
  return url.origin;
}

export function normalizeServer(raw, index) {
  const at = `servers[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${at} must be an object`);
  }
  if (typeof raw.id !== "string" || !SERVER_ID.test(raw.id)) {
    throw new Error(`${at}.id must match ${SERVER_ID}`);
  }
  const label = raw.label ?? raw.id;
  if (typeof label !== "string" || label.length < 1 || label.length > 32) {
    throw new Error(`${at}.label must be 1 to 32 characters`);
  }
  let parsed;
  try {
    parsed = new URL(raw.url);
  } catch {
    throw new Error(`${at}.url must be a valid server URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${at}.url is not a valid server URL: must use http or https`);
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(
      `${at}.url is not a valid server URL: origin only, no credentials, path, query, or fragment`,
    );
  }
  const username = raw.username ?? "opencode";
  if (typeof username !== "string" || username.length < 1) {
    throw new Error(`${at}.username must be a non-empty string`);
  }
  const password = raw.password ?? null;
  const passwordEnv = raw.passwordEnv ?? null;
  if (password !== null && passwordEnv !== null) {
    throw new Error(`${at} must set password or passwordEnv, not both`);
  }
  if (password !== null && typeof password !== "string") {
    throw new Error(`${at}.password must be a string`);
  }
  if (passwordEnv !== null && (typeof passwordEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(passwordEnv))) {
    throw new Error(`${at}.passwordEnv must be an environment variable name`);
  }
  const directory = raw.directory ?? null;
  if (directory !== null && typeof directory !== "string") {
    throw new Error(`${at}.directory must be a string or null`);
  }
  const enabled = raw.enabled === undefined ? true : raw.enabled;
  if (typeof enabled !== "boolean") {
    throw new Error(`${at}.enabled must be a boolean`);
  }
  return {
    id: raw.id,
    label,
    url: parsed.origin,
    username,
    password,
    passwordEnv,
    directory,
    enabled,
  };
}

function legacyServers(raw) {
  if (!raw.opencodeUrl) return null;
  return [{
    id: "default",
    label: "OpenCode",
    url: raw.opencodeUrl,
    username: "opencode",
    password: raw.opencodePassword ?? null,
    passwordEnv: null,
    directory: null,
    enabled: true,
  }];
}

export function normalizeConfig(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config must be an object");
  }
  const mode = raw.mode ?? (raw.opencodeUrl || raw.token ? "lan" : "proxy");
  if (mode !== "proxy" && mode !== "lan") throw new Error("config.mode must be proxy or lan");
  const allowInsecureUpstream = raw.allowInsecureUpstream === true;
  const migratedFromLegacy = !Array.isArray(raw.servers);
  const source = migratedFromLegacy ? legacyServers(raw) : raw.servers;
  if (!Array.isArray(source)) throw new Error("config requires at least one server");
  const servers = source.map(normalizeServer);
  for (const server of servers) {
    const url = new URL(server.url);
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname) && !allowInsecureUpstream) {
      throw new Error(
        `server url for servers[${server.id}] must not use plain HTTP to a non-loopback host`,
      );
    }
  }
  if (new Set(servers.map((server) => server.id)).size !== servers.length) {
    throw new Error("server ids must be unique");
  }
  if (servers.length < 1) throw new Error("config requires at least one server");
  if (servers.length > MAX_SERVERS) {
    throw new Error(`config requires at most ${MAX_SERVERS} servers`);
  }
  if (!servers.some((server) => server.enabled)) {
    throw new Error("config requires at least one server to be enabled");
  }

  const pollIntervalMs = raw.pollIntervalMs ?? 3000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 2000 || pollIntervalMs > 10000) {
    throw new Error("config.pollIntervalMs must be an integer from 2000 to 10000");
  }

  const base = {
    schemaVersion: SCHEMA_VERSION,
    mode,
    host: raw.host ?? "127.0.0.1",
    allowInsecureUpstream,
    pollIntervalMs,
    allowLegacyToken: mode === "lan" && (migratedFromLegacy || raw.allowLegacyToken === true),
    token: mode === "lan" ? raw.token ?? null : null,
    servers,
    vapid: raw.vapid ?? null,
    pairingSecret: raw.pairingSecret ?? null,
  };

  if (mode === "proxy") {
    const host = bareHost(base.host);
    if (!isLoopbackHost(host)) throw new Error("proxy mode host must be loopback");
    if (!raw.publicOrigin) throw new Error("proxy mode requires publicOrigin");
    const publicOrigin = parseOrigin(raw.publicOrigin, { name: "publicOrigin" });
    const httpPort = validPort(raw.httpPort ?? 8080, "httpPort");
    return { ...base, host, httpPort, publicOrigin, httpsPort: 8443, setupPort: 8081 };
  }

  const host = validLanHost(base.host);
  const httpsPort = validPort(raw.httpsPort ?? 8443, "httpsPort");
  const setupPort = validPort(raw.setupPort ?? 8081, "setupPort");
  return {
    ...base,
    host,
    httpsPort,
    setupPort,
    publicOrigin: `https://${originHost(host)}:${httpsPort}`,
    httpPort: null,
  };
}

export async function loadConfigV2(dataDir) {
  const dir = dataDir ?? activeDataDir();
  let raw;
  try {
    raw = JSON.parse(await readFile(configPath(dir), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("No config. Run: npm run setup");
    throw error;
  }
  return normalizeConfig(raw);
}

export async function saveConfigV2(input, dataDir) {
  const config = normalizeConfig(input);
  const dir = dataDir ?? activeDataDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temp = join(dir, `.config.${process.pid}.tmp`);
  await writeFile(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, configPath(dir));
  return config;
}
