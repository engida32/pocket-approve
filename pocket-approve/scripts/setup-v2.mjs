import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import webpush from "web-push";
import { DATA_DIR } from "../lib/config.mjs";
import { loadConfigV2, parseOrigin } from "../lib/config-v2.mjs";
import {
  backupV2Setup,
  buildMeta,
  buildSetupConfig,
  newPairingSecret,
  parseSetupArgs,
  writeV2Setup,
} from "../lib/setup-v2.mjs";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`usage: node scripts/setup-v2.mjs [options]
  --mode proxy|lan
  --public-origin https://host
  --server id=url          repeatable
  --server-label id=label  repeatable
  --server-dir id=/path    repeatable, scope a server to a project directory
  --host <lan-ip>          implies --mode lan
  --no-qr
  --force                  overwrite config (a timestamped backup is written)`);
}

async function lenientPrevious() {
  const raw = JSON.parse(await readFile(join(DATA_DIR, "config.json"), "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const previous = {};
  if (raw.mode === "proxy" || raw.mode === "lan") previous.mode = raw.mode;
  if (typeof raw.host === "string" && raw.host.length > 0) previous.host = raw.host;
  for (const name of ["httpPort", "httpsPort", "setupPort"]) {
    if (Number.isInteger(raw[name]) && raw[name] >= 1 && raw[name] <= 65_535) {
      previous[name] = raw[name];
    }
  }
  if (Number.isInteger(raw.pollIntervalMs)
    && raw.pollIntervalMs >= 2000
    && raw.pollIntervalMs <= 10_000) {
    previous.pollIntervalMs = raw.pollIntervalMs;
  }
  if (typeof raw.publicOrigin === "string") {
    try {
      previous.publicOrigin = parseOrigin(raw.publicOrigin, { name: "publicOrigin" });
    } catch {
      // An invalid old origin is not a safe field to carry forward.
    }
  }
  if (typeof raw.token === "string") previous.token = raw.token;
  if (typeof raw.pairingSecret === "string" && raw.pairingSecret.length >= 20) {
    previous.pairingSecret = raw.pairingSecret;
  }
  if (raw.vapid && typeof raw.vapid === "object"
    && typeof raw.vapid.publicKey === "string"
    && typeof raw.vapid.privateKey === "string") {
    previous.vapid = {
      subject: raw.vapid.subject,
      publicKey: raw.vapid.publicKey,
      privateKey: raw.vapid.privateKey,
    };
  }
  return previous;
}

async function previousConfig(options) {
  try {
    return { previous: await loadConfigV2(), unreadable: null };
  } catch (error) {
    if (/No config/.test(error.message)) return { previous: null, unreadable: null };
    if (!options.force) throw error;
    if (/must not use plain HTTP/.test(error.message)) {
      if (options.servers.length > 0) {
        return { previous: await lenientPrevious(), unreadable: null };
      }
      const hostFlag = options.host ? `--host ${options.host} ` : "";
      const example = options.mode === "lan"
        ? `--force --mode lan ${hostFlag}--server local=http://127.0.0.1:4096`
        : "--force --mode proxy --public-origin https://approve.example.com "
          + "--server local=http://127.0.0.1:4096";
      throw new Error(
        "existing config has a plain-HTTP non-loopback upstream. "
        + "Either fix that URL to https or loopback http, or delete config.json "
        + `and rerun with the full setup flags (for example: ${example}).`,
      );
    }
    return { previous: null, unreadable: error };
  }
}

async function main() {
  const options = parseSetupArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const { previous, unreadable } = await previousConfig(options);
  if (previous && !options.force) {
    throw new Error("config already exists; back it up and pass --force to reconfigure");
  }
  const backup = options.force ? await backupV2Setup() : null;
  if (unreadable) {
    const reason = unreadable.name === "SyntaxError" ? "invalid JSON" : unreadable.message;
    console.warn(`setup: existing config could not be read (${reason}).`);
    console.warn("setup: VAPID and pairing keys will be regenerated if they cannot be recovered.");
  }
  if (backup) console.log(`Backup: ${backup}`);
  const vapid = previous?.vapid ?? {
    ...webpush.generateVAPIDKeys(),
    subject: "mailto:pocket-approve@localhost",
  };
  const pairingSecret = previous?.pairingSecret ?? newPairingSecret();
  const config = buildSetupConfig({ options, previous, env: process.env, vapid, pairingSecret });
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  if (unreadable) await rm(join(DATA_DIR, "config.json"), { force: true });

  if (config.mode === "lan") {
    await run(process.execPath, [
      join(HERE, "setup.mjs"),
      "--host", config.host,
      "--no-qr",
    ], { env: { ...process.env, POCKET_APPROVE_DATA: DATA_DIR } });
  }

  await writeV2Setup(config, buildMeta({ vapid }));
  await chmod(DATA_DIR, 0o700);

  if (config.mode === "proxy") {
    console.log(`Pocket Approve proxy config written for ${config.publicOrigin}.`);
    console.log("  Start: npm start");
    console.log("  Pair:  npm run pair -- --label \"My phone\"");
  } else {
    console.log(`Pocket Approve LAN config written for ${config.host}.`);
    console.log(`  Certificate install: http://${config.host}:${config.setupPort}/`);
    console.log(`  App: https://${config.host}:${config.httpsPort}/`);
    console.log("  Legacy local CA mode. Prefer proxy mode for new installs.");
  }
  if (options.qr && config.mode === "lan") {
    const qrcode = (await import("qrcode-terminal")).default;
    qrcode.generate(`https://${config.host}:${config.httpsPort}/`, { small: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`setup: ${error.message}`);
    process.exit(1);
  });
}
