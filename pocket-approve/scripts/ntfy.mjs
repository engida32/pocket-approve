#!/usr/bin/env node
import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { DATA_DIR } from "../lib/config.mjs";
import { loadConfigV2 } from "../lib/config-v2.mjs";
import { createNtfyRuntime } from "../lib/ntfy-runtime.mjs";
import {
  createSettings,
  loadSettings,
  ntfyLink,
  rotateSettings,
  saveSettings,
} from "../lib/ntfy.mjs";
import { acquirePid, releasePid, stopPid } from "../lib/ntfy-lifecycle.mjs";

const DEFAULT_OPENCODE = "http://127.0.0.1:4096";
const MAX_SERVERS = 50;

function originOnly(value, flag) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${flag} must be an http or https URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${flag} must be an http or https URL`);
  }
  if (url.username || url.password) {
    throw new Error(`${flag} must not include credentials`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${flag} must be an origin such as ${DEFAULT_OPENCODE}`);
  }
  return url.origin;
}

export async function discoverSessions({
  baseUrl = DEFAULT_OPENCODE,
  fetchImpl = fetch,
  timeoutMs = 5000,
} = {}) {
  const origin = originOnly(baseUrl, "OpenCode URL");
  const url = new URL("/session", origin);
  url.searchParams.set("limit", "1000");
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`cannot reach OpenCode at ${origin}: ${error.message}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`OpenCode returned HTTP ${response.status} for /session`);
  }
  const sessions = await response.json();
  if (!Array.isArray(sessions)) {
    throw new Error("OpenCode returned an unexpected session list");
  }
  return sessions;
}

export function directoriesFromSessions(sessions, limit = MAX_SERVERS) {
  if (!Array.isArray(sessions)) throw new Error("sessions must be an array");
  const latest = new Map();
  for (const session of sessions) {
    const directory = session?.directory;
    if (typeof directory !== "string" || !isAbsolute(directory)) continue;
    const updated = Number(session?.time?.updated);
    const stamp = Number.isFinite(updated) ? updated : 0;
    const prior = latest.get(directory);
    if (prior === undefined || stamp > prior) latest.set(directory, stamp);
  }
  return [...latest.entries()]
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

export function serversForDirectories(directories, { url = DEFAULT_OPENCODE } = {}) {
  const unique = [
    ...new Set(
      directories.filter((directory) => typeof directory === "string" && isAbsolute(directory)),
    ),
  ];
  if (unique.length === 0) {
    return [{ id: "local", label: "OpenCode", url, directory: null }];
  }
  return unique.map((directory) => {
    const label = labelFor(directory);
    const digest = createHash("sha256").update(directory).digest("hex").slice(0, 8);
    return { id: `${slug(label) || "project"}-${digest}`, label, url, directory };
  });
}

function usage() {
  console.log(`Pocket Approve ntfy

Usage:
  npm run connect [options]
  npm run disconnect

Options:
  --opencode <url>   OpenCode server used to discover projects (default ${DEFAULT_OPENCODE})
  --label <name>     QR display name (default "Pocket Approve")
  --no-qr             Do not print the QR code
  --rotate            Replace topics and secret, then print a new QR
  --test              Publish a test notification and wait for its reply
  --allow-always      Include the Always allow action (default)
  --no-always         Omit the Always allow action
  --show-topic        Print the outbound topic for manual iOS setup
  --disconnect        Stop the running connect process
  --help              Show this help`);
}

function parseArgs(argv) {
  const options = {
    opencode: DEFAULT_OPENCODE,
    label: "Pocket Approve",
    noQr: false,
    rotate: false,
    test: false,
    allowAlways: true,
    showTopic: false,
    disconnect: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") options.help = true;
    else if (arg === "--disconnect") options.disconnect = true;
    else if (arg === "--no-qr") options.noQr = true;
    else if (arg === "--rotate") options.rotate = true;
    else if (arg === "--test") options.test = true;
    else if (arg === "--allow-always") options.allowAlways = true;
    else if (arg === "--no-always") options.allowAlways = false;
    else if (arg === "--show-topic") options.showTopic = true;
    else if (arg === "--opencode") {
      const value = argv[++index];
      if (!value) throw new Error("--opencode needs a value");
      options.opencode = value;
    } else if (arg === "--label") {
      const value = argv[++index];
      if (!value) throw new Error("--label needs a value");
      if (value.length > 64) throw new Error("--label must be 64 characters or fewer");
      options.label = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function loadServers(options) {
  try {
    const config = await loadConfigV2(DATA_DIR);
    if (Array.isArray(config.servers) && config.servers.length > 0) {
      return { servers: config.servers, pollIntervalMs: config.pollIntervalMs };
    }
  } catch (error) {
    if (!String(error.message).startsWith("No config")) throw error;
  }
  const sessions = await discoverSessions({ baseUrl: options.opencode });
  const directories = directoriesFromSessions(sessions, MAX_SERVERS);
  const servers = serversForDirectories(directories, { url: options.opencode }).map((server) => ({
    ...server,
    enabled: true,
    username: "opencode",
    password: null,
  }));
  return { servers, pollIntervalMs: 3000 };
}

async function qr(value) {
  const { default: qrcode } = await import("qrcode-terminal");
  qrcode.generate(value, { small: true });
}

async function waitForSignal() {
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (options.disconnect) {
    const result = await stopPid(DATA_DIR);
    if (result === "none") console.log("Not connected.");
    else if (result === "stale") console.log("Removed a stale connection file.");
    else if (result === "stopped") console.log("Disconnected.");
    else {
      console.error("The connect process did not stop within five seconds.");
      process.exitCode = 1;
    }
    return;
  }

  const { servers, pollIntervalMs } = await loadServers(options);
  if (servers.length === 0) throw new Error("No OpenCode servers found. Start OpenCode or run npm run setup.");
  let settings = await loadSettings(DATA_DIR);
  if (!settings) settings = createSettings();
  if (options.rotate) settings = rotateSettings(settings);
  settings = await saveSettings(DATA_DIR, settings);

  await acquirePid(DATA_DIR);
  let runtime = null;
  try {
    runtime = createNtfyRuntime({
      servers,
      pollIntervalMs,
      dataDir: DATA_DIR,
      settings,
      allowAlways: options.allowAlways,
    });
    await runtime.init();
    await runtime.start();

    console.log(`Watching ${servers.length} server(s) through ${settings.baseUrl}.`);
    console.log("Desktop notifications stay on when the desktop notifier is available.");
    console.log("Do not run npm run phone at the same time. It would poll the same servers and send duplicate notifications.");
    if (!options.noQr) {
      console.log("Scan this with the ntfy Android app:");
      await qr(ntfyLink(settings, options.label));
    }
    if (options.showTopic) {
      console.log(`iOS manual setup: server ${new URL(settings.baseUrl).host}, topic ${settings.outTopic}`);
    } else {
      console.log("For iOS, run npm run connect -- --show-topic and add the server and topic manually.");
    }
    if (options.test) {
      const { id } = await runtime.ntfy.sendTest();
      console.log("Test notification sent. Tap the button on your phone.");
      await runtime.ntfy.waitForTest(id);
      console.log("Test reply received.");
    }
    console.log("Press Ctrl+C to disconnect. The phone stays subscribed.");
    await waitForSignal();
  } finally {
    if (runtime) await runtime.stop();
    await releasePid(DATA_DIR, process.pid);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
