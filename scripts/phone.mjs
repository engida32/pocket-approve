import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DATA_DIR } from "../lib/config.mjs";
import { MAX_SERVERS, loadConfigV2 } from "../lib/config-v2.mjs";
import {
  buildSetupArgs,
  directoriesFromSessions,
  discoverSessions,
  pairingUrl,
  parsePhoneArgs,
  sameServers,
  serversForDirectories,
} from "../lib/phone.mjs";
import { chooseHost, detectLanIp } from "./setup.mjs";
import { start } from "../lib/runtime.mjs";

const run = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));

function usage() {
  console.log(`usage: npm run phone [options]
  --host <lan-ip>       override the detected Wi-Fi address
  --opencode <url>      OpenCode server (default http://127.0.0.1:4096)
  --label <name>        name for the phone being paired (default Phone)
  --no-qr               do not print QR codes
  --help`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function previousConfig() {
  try {
    return { config: await loadConfigV2(), unreadable: false };
  } catch (error) {
    if (/No config/.test(error.message)) return { config: null, unreadable: false };
    return { config: null, unreadable: true };
  }
}

async function configure({ host, servers, force }) {
  const script = join(HERE, "setup-v2.mjs");
  const args = [script, ...buildSetupArgs({ host, servers, force })];
  try {
    await run(process.execPath, args, {
      env: { ...process.env, POCKET_APPROVE_DATA: DATA_DIR },
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const detail = error?.stderr?.trim() || error?.message || String(error);
    throw new Error(`setup failed: ${detail}`, { cause: error });
  }
}

function qr(url, small = true) {
  return import("qrcode-terminal").then((module) => {
    module.default.generate(url, { small });
  });
}

async function waitForSignal() {
  await new Promise(() => {});
}

export async function main(argv = process.argv.slice(2)) {
  const options = parsePhoneArgs(argv);
  if (options.help) {
    usage();
    return;
  }

  const sessions = await discoverSessions({ baseUrl: options.opencode });
  const discovered = directoriesFromSessions(sessions, MAX_SERVERS + 1);
  const truncated = discovered.length > MAX_SERVERS;
  const directories = discovered.slice(0, MAX_SERVERS);
  const servers = serversForDirectories(directories, { url: options.opencode });

  const loaded = await previousConfig();
  const previous = loaded.config;
  if (previous?.mode === "proxy") {
    throw new Error("the existing config uses proxy mode; phone setup only manages the LAN workflow");
  }
  if (previous?.servers?.some((server) => server.password || server.passwordEnv)) {
    throw new Error("the existing config has an OpenCode password; remove it before using phone setup");
  }

  const host = chooseHost({
    explicitHost: options.host,
    detectedIp: detectLanIp(),
    savedHost: previous?.host,
  });
  if (!host) throw new Error("cannot find a Wi-Fi IPv4 address; pass --host <lan-ip>");

  const configPath = join(DATA_DIR, "config.json");
  const configExists = await exists(configPath);
  const hasCa = await exists(join(DATA_DIR, "ca.crt"));
  const hasCert = await exists(join(DATA_DIR, "server.crt"));
  const firstRun = !hasCa;
  const needsSetup =
    !previous ||
    previous.mode !== "lan" ||
    previous.host !== host ||
    !hasCa ||
    !hasCert ||
    !sameServers(previous.servers, servers);

  if (needsSetup) {
    await configure({ host, servers, force: configExists });
  }

  const config = await loadConfigV2();
  if (config.mode !== "lan") throw new Error("phone setup expected a LAN config");

  let running = null;
  try {
    running = await start({ config, dataDir: DATA_DIR });
    const pair = await running.runtime.pairing.open(options.label);
    const appUrl = config.publicOrigin;
    const caUrl = `http://${config.host}:${config.setupPort}/`;
    const pairUrl = pairingUrl(appUrl, pair.code, pair.label);

    console.log(`Pocket Approve is ready for ${config.host}.`);
    console.log(`  App:   ${appUrl}`);
    console.log(`  Certificate: ${caUrl}`);
    console.log(`  Code:  ${pair.code}`);
    console.log(`  Expires: ${new Date(pair.expiresAt).toLocaleTimeString()}`);
    if (truncated) {
      console.log(`  Only the ${MAX_SERVERS} most recent projects are watched.`);
    }

    if (firstRun) {
      console.log("");
      console.log("First time on this phone:");
      console.log(`1. Open ${caUrl} and install the local certificate.`);
      console.log("2. Then scan the pairing QR below.");
      if (options.qr) {
        console.log("");
        console.log("Certificate page:");
        await qr(caUrl);
      }
    }

    console.log("");
    console.log("Pairing QR:");
    if (options.qr) await qr(pairUrl);
    console.log(pairUrl);
    console.log("");
    console.log("Keep this running. Press Ctrl+C to stop.");

    const shutdown = async (signal) => {
      if (shutdown.stopping) return;
      shutdown.stopping = true;
      console.log(`\nStopping (${signal})...`);
      try {
        await running.stop();
        process.exit(0);
      } catch (error) {
        console.error(`phone: stop failed: ${error?.code ?? error?.name ?? "unknown"}`);
        process.exit(1);
      }
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    await waitForSignal();
  } catch (error) {
    if (running) await running.stop().catch(() => {});
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`phone: ${error.message}`);
    process.exitCode = 1;
  });
}
