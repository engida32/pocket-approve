import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./config.mjs";
import { normalizeConfig, saveConfigV2, SCHEMA_VERSION } from "./config-v2.mjs";
import { chooseHost, detectLanIp } from "../scripts/setup.mjs";


function fail(message) {
  throw new Error(message);
}

function pairValue(flag, value) {
  if (typeof value !== "string" || !value.includes("=")) {
    fail(`${flag} needs id=value`);
  }
  const at = value.indexOf("=");
  return [value.slice(0, at), value.slice(at + 1)];
}

export function parseSetupArgs(argv = []) {
  const options = {
    mode: null,
    host: null,
    publicOrigin: null,
    servers: [],
    labels: {},
    qr: true,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--mode") {
      options.mode = next();
      if (!["proxy", "lan"].includes(options.mode)) fail("--mode must be proxy or lan");
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice(7);
      if (!["proxy", "lan"].includes(options.mode)) fail("--mode must be proxy or lan");
    } else if (arg === "--host") {
      options.host = next();
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice(7);
    } else if (arg === "--public-origin") {
      options.publicOrigin = next();
    } else if (arg.startsWith("--public-origin=")) {
      options.publicOrigin = arg.slice(16);
    } else if (arg === "--server") {
      const [id, url] = pairValue("--server", next());
      options.servers.push({ id, url });
    } else if (arg === "--server-label") {
      const [id, label] = pairValue("--server-label", next());
      options.labels[id] = label;
    } else if (arg === "--no-qr") {
      options.qr = false;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (!options.mode) options.mode = options.host ? "lan" : "proxy";
  return options;
}

function serverEntries(options, previous, env) {
  const source = options.servers.length ? options.servers : previous?.servers;
  if (Array.isArray(source) && source.length) {
    return source.map((server) => ({ ...server }));
  }
  return [{
    id: "default",
    label: "OpenCode",
    url: env.OPENCODE_URL ?? "http://127.0.0.1:4096",
    passwordEnv: env.OPENCODE_SERVER_PASSWORD ? "OPENCODE_SERVER_PASSWORD" : null,
  }];
}

export function buildSetupConfig({ options, previous = null, env = process.env, vapid, pairingSecret } = {}) {
  if (!vapid?.publicKey || !vapid?.privateKey) fail("VAPID keys are required");
  if (typeof pairingSecret !== "string" || pairingSecret.length < 20) fail("pairing secret is required");
  const servers = serverEntries(options, previous, env).map((server) => ({
    ...server,
    label: options.labels[server.id] ?? server.label ?? server.id,
  }));
  const base = {
    mode: options.mode,
    trustProxy: true,
    allowInsecureUpstream: false,
    pollIntervalMs: previous?.pollIntervalMs ?? 3000,
    servers,
    vapid: {
      subject: vapid.subject ?? "mailto:pocket-approve@localhost",
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    },
    pairingSecret,
  };

  if (options.mode === "proxy") {
    return normalizeConfig({
      ...base,
      host: "127.0.0.1",
      httpPort: options.httpPort ?? previous?.httpPort ?? 8080,
      publicOrigin: options.publicOrigin ?? (previous?.mode === "proxy" ? previous.publicOrigin : null),
      allowLegacyToken: false,
      token: null,
    });
  }

  const host = chooseHost({
    explicitHost: options.host,
    detectedIp: detectLanIp(),
    savedHost: previous?.host,
  });
  if (!host) fail("could not detect a LAN IPv4 address; pass --host <ip>");
  return normalizeConfig({
    ...base,
    host,
    httpsPort: previous?.httpsPort ?? 8443,
    setupPort: previous?.setupPort ?? 8081,
    allowLegacyToken: Boolean(previous?.token),
    token: previous?.token ?? null,
  });
}

export function vapidPairFingerprint(vapid) {
  return createHash("sha256").update(vapid.publicKey).digest("hex");
}

export function buildMeta({ vapid, now = () => new Date() } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: now().toISOString(),
    vapidFingerprint: vapidPairFingerprint(vapid),
  };
}

export async function backupV2Setup(dataDir = DATA_DIR, now = () => new Date()) {
  const present = [];
  for (const name of ["config.json", "meta.json"]) {
    try {
      await stat(join(dataDir, name));
      present.push(name);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (present.length === 0) return null;
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(dataDir, `backup-${stamp}`);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  await chmod(backupDir, 0o700);
  for (const name of present) {
    const target = join(backupDir, name);
    await copyFile(join(dataDir, name), target);
    await chmod(target, 0o600);
  }
  return backupDir;
}

export async function writeV2Setup(config, meta, dataDir = DATA_DIR) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  await saveConfigV2(config, dataDir);
  const metaPath = join(dataDir, "meta.json");
  const temp = join(dataDir, `.meta.${process.pid}.tmp`);
  await writeFile(temp, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
  await chmod(temp, 0o600);
  const { rename } = await import("node:fs/promises");
  await rename(temp, metaPath);
  await chmod(metaPath, 0o600);
}

export function newPairingSecret() {
  return randomBytes(32).toString("base64url");
}
