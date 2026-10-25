import { execFile } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import webpush from "web-push";
import { DATA_DIR } from "../lib/config.mjs";
import { loadConfigV2 } from "../lib/config-v2.mjs";
import {
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
  --host <lan-ip>          implies --mode lan
  --no-qr
  --force                  overwrite config (data/ is not backed up)`);
}

async function previousConfig() {
  try {
    return await loadConfigV2();
  } catch (error) {
    if (/No config/.test(error.message)) return null;
    throw error;
  }
}

async function main() {
  const options = parseSetupArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const previous = await previousConfig();
  if (previous && !options.force) {
    throw new Error("config already exists; back it up and pass --force to reconfigure");
  }
  const vapid = previous?.vapid ?? {
    ...webpush.generateVAPIDKeys(),
    subject: "mailto:pocket-approve@localhost",
  };
  const pairingSecret = previous?.pairingSecret ?? newPairingSecret();
  const config = buildSetupConfig({ options, previous, env: process.env, vapid, pairingSecret });
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });

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
