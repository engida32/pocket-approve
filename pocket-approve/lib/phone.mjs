import { createHash } from "node:crypto";
import { isAbsolute, basename } from "node:path";
import { MAX_SERVERS } from "./config-v2.mjs";

const DEFAULT_OPENCODE = "http://127.0.0.1:4096";
const DEFAULT_LABEL = "Phone";

function fail(message) {
  throw new Error(message);
}

function textFlag(arg, value) {
  if (typeof value !== "string" || value.length === 0) fail(`${arg} needs a value`);
  return value;
}

function originOnly(value, flag) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${flag} must be an http or https URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) fail(`${flag} must be an http or https URL`);
  if (url.username || url.password) fail(`${flag} must not include credentials`);
  if (url.pathname !== "/" || url.search || url.hash) fail(`${flag} must be an origin such as http://127.0.0.1:4096`);
  return url.origin;
}

export function parsePhoneArgs(argv = []) {
  const options = {
    host: null,
    opencode: DEFAULT_OPENCODE,
    label: DEFAULT_LABEL,
    qr: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--host") {
      options.host = textFlag("--host", next());
    } else if (arg.startsWith("--host=")) {
      options.host = textFlag("--host", arg.slice(7));
    } else if (arg === "--opencode") {
      options.opencode = originOnly(textFlag("--opencode", next()), "--opencode");
    } else if (arg.startsWith("--opencode=")) {
      options.opencode = originOnly(textFlag("--opencode", arg.slice(11)), "--opencode");
    } else if (arg === "--label") {
      options.label = textFlag("--label", next()).trim();
    } else if (arg.startsWith("--label=")) {
      options.label = textFlag("--label", arg.slice(8)).trim();
    } else if (arg === "--no-qr") {
      options.qr = false;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  options.opencode = originOnly(options.opencode, "--opencode");
  if (options.label.length === 0 || options.label.length > 64) {
    fail("--label must be between 1 and 64 characters");
  }
  return options;
}

export function directoriesFromSessions(sessions, limit = MAX_SERVERS) {
  if (!Array.isArray(sessions)) fail("sessions must be an array");
  const seen = new Map();
  for (const session of sessions) {
    const directory = session?.directory;
    if (typeof directory !== "string" || !isAbsolute(directory)) continue;
    const updated = Number(session?.time?.updated);
    const stamp = Number.isFinite(updated) ? updated : 0;
    const prior = seen.get(directory);
    if (prior === undefined || stamp > prior) seen.set(directory, stamp);
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, limit))
    .map(([directory]) => directory);
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
}

function labelFor(directory) {
  const raw = basename(directory) || "OpenCode";
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() || "OpenCode";
  return cleaned.slice(0, 32);
}

export function serverIdFor(directory) {
  const digest = createHash("sha256").update(directory).digest("hex").slice(0, 8);
  const prefix = slug(labelFor(directory)) || "project";
  return `${prefix}-${digest}`.slice(0, 32);
}

export function serversForDirectories(directories, { url = DEFAULT_OPENCODE } = {}) {
  const unique = [...new Set(directories.filter((directory) => typeof directory === "string" && isAbsolute(directory)))];
  if (unique.length === 0) {
    return [{ id: "local", label: "OpenCode", url, directory: null }];
  }
  return unique.map((directory) => ({
    id: serverIdFor(directory),
    label: labelFor(directory),
    url,
    directory,
  }));
}

export function sameServers(left, right) {
  const normalize = (servers) => {
    if (!Array.isArray(servers)) return [];
    return servers
      .map((server) => [
        server.id,
        server.url,
        server.label ?? server.id,
        server.directory ?? null,
        server.enabled !== false,
        server.passwordEnv ?? null,
        Boolean(server.password),
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function buildSetupArgs({ host, servers, force = false }) {
  const args = ["--mode", "lan", "--host", host];
  for (const server of servers) {
    args.push("--server", `${server.id}=${server.url}`);
    if (server.label && server.label !== server.id) {
      args.push("--server-label", `${server.id}=${server.label}`);
    }
    if (server.directory) args.push("--server-dir", `${server.id}=${server.directory}`);
  }
  args.push("--no-qr");
  if (force) args.push("--force");
  return args;
}

export function pairingUrl(origin, code) {
  return `${origin.replace(/\/+$/, "")}/pair#code=${encodeURIComponent(code)}`;
}

export async function discoverSessions({ baseUrl = DEFAULT_OPENCODE, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const url = new URL("/session", originOnly(baseUrl, "OpenCode URL"));
  url.searchParams.set("limit", "1000");
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`cannot reach OpenCode at ${originOnly(baseUrl, "OpenCode URL")}: ${error.message}`, { cause: error });
  }
  if (!response.ok) {
    fail(`OpenCode returned HTTP ${response.status} for /session`);
  }
  const sessions = await response.json();
  if (!Array.isArray(sessions)) fail("OpenCode returned an unexpected session list");
  return sessions;
}
