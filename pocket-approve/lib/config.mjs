import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export const DATA_DIR = resolve(
  process.env.POCKET_APPROVE_DATA ?? join(PROJECT_DIR, "data"),
);
export const CONFIG_PATH = join(DATA_DIR, "config.json");

const DEFAULTS = Object.freeze({
  host: null,
  httpsPort: 8443,
  setupPort: 8081,
  token: null,
  opencodeUrl: "http://127.0.0.1:4096",
  opencodePassword: null,
  vapid: null,
});

function assertBindableHost(host) {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    throw new Error("host must be a specific LAN address, never a wildcard");
  }
}

export async function loadConfig() {
  let raw;
  try {
    raw = await readFile(CONFIG_PATH, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`No config at ${CONFIG_PATH}. Run: npm run setup`);
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Invalid JSON in ${CONFIG_PATH}. Remove it and run: npm run setup`,
    );
  }

  return { ...DEFAULTS, ...parsed };
}

export async function saveConfig(config) {
  assertBindableHost(config.host);
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ ...DEFAULTS, ...config }, null, 2) + "\n";
  await writeFile(CONFIG_PATH, body, { mode: 0o600 });
  await chmod(CONFIG_PATH, 0o600);
}
