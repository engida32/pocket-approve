import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";
import { createOpenCodeSource } from "./lib/adapters/opencode.mjs";
import { createApp } from "./lib/app.mjs";
import { DATA_DIR, loadConfig } from "./lib/config.mjs";
import { createDesktop } from "./lib/desktop.mjs";
import { createClient } from "./lib/opencode.mjs";
import { createPush } from "./lib/push.mjs";
import { readTls } from "./lib/tls.mjs";

function assertBindableHost(host) {
  if (typeof host !== "string" || host.trim() === "") {
    throw new Error("config.host is required");
  }
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    throw new Error("config.host must be a specific address, never a wildcard");
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export async function start() {
  const config = await loadConfig();
  assertBindableHost(config.host);

  const tls = await readTls(DATA_DIR);
  const source = createOpenCodeSource(
    createClient({
      baseUrl: config.opencodeUrl,
      password: config.opencodePassword,
    }),
  );
  const push = createPush({ dataDir: DATA_DIR, vapid: config.vapid });
  const desktop = createDesktop();
  const app = createApp({
    source,
    push,
    desktop,
    config: { ...config, dataDir: DATA_DIR },
  });

  const httpsServer = https.createServer(tls, app.handler);
  const setupServer = http.createServer(app.setupHandler);

  await listen(httpsServer, config.httpsPort, config.host);
  try {
    await listen(setupServer, config.setupPort, config.host);
  } catch (error) {
    await closeServer(httpsServer);
    throw error;
  }

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    desktop.stop?.();
    await Promise.all([closeServer(httpsServer), closeServer(setupServer)]);
  }

  process.once("SIGINT", () => {
    stop().finally(() => {
      process.exitCode = 0;
    });
  });
  process.once("SIGTERM", () => {
    stop().finally(() => {
      process.exitCode = 0;
    });
  });

  return { config, app, httpsServer, setupServer, desktop, stop };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await start();
  } catch (error) {
    console.error(`pocket-approve: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  }
}
