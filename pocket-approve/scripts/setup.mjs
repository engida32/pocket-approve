import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import webpush from "web-push";
import { CONFIG_PATH, DATA_DIR, loadConfig, saveConfig } from "../lib/config.mjs";
import { certHasIp } from "../lib/tls.mjs";

const run = promisify(execFile);

const CA_KEY = join(DATA_DIR, "ca.key");
const CA_CERT = join(DATA_DIR, "ca.crt");
const CA_SERIAL = join(DATA_DIR, "ca.srl");
const SERVER_KEY = join(DATA_DIR, "server.key");
const SERVER_CERT = join(DATA_DIR, "server.crt");
const SERVER_CSR = join(DATA_DIR, "server.csr");
const SERVER_EXT = join(DATA_DIR, "server.ext");

const SKIP_PREFIXES = ["172.16.", "172.17.", "172.18.", "192.168.122."];

function usage() {
  console.log("usage: node scripts/setup.mjs [--host <lan-ip>] [--no-qr]");
}

function fail(message) {
  console.error(`setup: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let host = null;
  let qr = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host") {
      host = argv[i + 1];
      if (!host) fail("--host needs a value");
      i += 1;
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    } else if (arg === "--no-qr") {
      qr = false;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return { host, qr };
}

export function detectLanIp(interfaces = networkInterfaces()) {
  const candidates = [];
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      const isV4 = address.family === "IPv4" || address.family === 4;
      if (!isV4 || address.internal) continue;
      if (SKIP_PREFIXES.some((prefix) => address.address.startsWith(prefix))) continue;
      candidates.push(address.address);
    }
  }
  const rank = (ip) =>
    ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : 2;
  candidates.sort((a, b) => rank(a) - rank(b));
  return candidates[0] ?? null;
}

export function chooseHost({ explicitHost = null, detectedIp = null, savedHost = null } = {}) {
  return explicitHost ?? detectedIp ?? savedHost ?? null;
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

async function existingConfig() {
  try {
    await stat(CONFIG_PATH);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  return loadConfig();
}

async function generateCa() {
  await run(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      CA_KEY,
      "-out",
      CA_CERT,
      "-days",
      "3650",
      "-subj",
      "/CN=Pocket Approve Local CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    { cwd: DATA_DIR },
  );
}

async function generateServerCert(host) {
  await run(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      SERVER_KEY,
      "-out",
      SERVER_CSR,
      "-subj",
      `/CN=${host}`,
    ],
    { cwd: DATA_DIR },
  );

  await writeFile(
    SERVER_EXT,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=IP:${host},DNS:localhost,IP:127.0.0.1`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  await run(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      SERVER_CSR,
      "-CA",
      CA_CERT,
      "-CAkey",
      CA_KEY,
      "-CAserial",
      CA_SERIAL,
      "-CAcreateserial",
      "-out",
      SERVER_CERT,
      "-days",
      "825",
      "-sha256",
      "-extfile",
      SERVER_EXT,
    ],
    { cwd: DATA_DIR },
  );

  await rm(SERVER_CSR, { force: true });
  await rm(SERVER_EXT, { force: true });
}

async function certMatchesHost(host) {
  if (!(await fileExists(SERVER_KEY)) || !(await fileExists(SERVER_CERT))) {
    return false;
  }
  try {
    return await certHasIp(SERVER_CERT, host);
  } catch {
    return false;
  }
}

async function printQr(url) {
  try {
    const { default: qrcode } = await import("qrcode-terminal");
    qrcode.generate(url, { small: true });
  } catch {
    console.log("(QR skipped: qrcode-terminal not installed)");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const previous = await existingConfig();

  const detectedIp = detectLanIp();
  const host = chooseHost({
    explicitHost: options.host,
    detectedIp,
    savedHost: previous?.host,
  });
  if (!host) {
    fail("could not detect a LAN IPv4 address; pass --host <ip>");
  }
  if (!isIPv4(host) || host === "0.0.0.0") {
    fail(`host must be a single IPv4 LAN address, got: ${host}`);
  }

  const httpsPort = previous?.httpsPort ?? 8443;
  const setupPort = previous?.setupPort ?? 8081;
  const token = previous?.token ?? randomBytes(24).toString("hex");
  const vapid = previous?.vapid ?? webpush.generateVAPIDKeys();
  const opencodeUrl =
    process.env.OPENCODE_URL ?? previous?.opencodeUrl ?? "http://127.0.0.1:4096";
  const opencodePassword =
    process.env.OPENCODE_SERVER_PASSWORD ?? previous?.opencodePassword ?? null;

  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });

  const caExists = (await fileExists(CA_KEY)) && (await fileExists(CA_CERT));
  if (!caExists) {
    await generateCa();
    console.log(`Generated a new local CA at ${CA_CERT}`);
  }

  if (!caExists || !(await certMatchesHost(host))) {
    await generateServerCert(host);
  }

  await saveConfig({
    host,
    httpsPort,
    setupPort,
    token,
    opencodeUrl,
    opencodePassword,
    vapid: {
      subject: vapid.subject ?? "mailto:pocket-approve@localhost",
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    },
  });

  for (const path of [CA_KEY, CA_CERT, SERVER_KEY, SERVER_CERT, CONFIG_PATH]) {
    await chmod(path, 0o600);
  }
  if (await fileExists(CA_SERIAL)) await chmod(CA_SERIAL, 0o600);
  await chmod(DATA_DIR, 0o700);

  const appUrl = `https://${host}:${httpsPort}/#token=${token}`;
  const setupUrl = `http://${host}:${setupPort}/`;

  console.log(`Pocket Approve is configured for ${host}.`);
  console.log(`  Certificate install: ${setupUrl}`);
  console.log(`  App: ${appUrl}`);
  if (options.qr) await printQr(appUrl);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    fail(err?.stderr?.trim() || err?.message || String(err));
  }
}
