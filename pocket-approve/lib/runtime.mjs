import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./config.mjs";
import { loadConfigV2 } from "./config-v2.mjs";
import { createAdmin } from "./admin.mjs";
import { createAppV2 } from "./app-v2.mjs";
import { createAuditLog } from "./audit.mjs";
import { createDesktop } from "./desktop.mjs";
import { createDeviceStore } from "./devices.mjs";
import { createFleet } from "./fleet.mjs";
import { createNotifications } from "./notifications.mjs";
import { createPairing } from "./pairing.mjs";
import { createPush } from "./push.mjs";
import { createSeenStore } from "./seen.mjs";
import { toNodeHandler } from "./node-http.mjs";
import { readTls } from "./tls.mjs";

const ADMIN_SOCKET = "admin.sock";

function setupPage() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pocket Approve CA</title>
<style>body{font:17px system-ui;max-width:38rem;margin:3rem auto;padding:0 1rem;line-height:1.5}a{display:inline-block;min-height:44px;padding:.7rem 1rem;background:#111;color:#fff;text-decoration:none;border-radius:.5rem}</style>
</head>
<body><h1>Install the local certificate</h1>
<p>This legacy LAN mode uses a private certificate authority. Install the certificate on the phone, then follow the device instructions to trust it.</p>
<p><a href="/ca.crt" download>Download ca.crt</a></p></body></html>`;
}

export function createLanSetupHandler({ dataDir = DATA_DIR, log = console } = {}) {
  const page = setupPage();
  return async function setupHandler(request) {
    const url = new URL(request.url);
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
    }
    if (url.pathname === "/") {
      return new Response(page, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (url.pathname === "/ca.crt") {
      try {
        const body = await readFile(join(dataDir, "ca.crt"));
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/x-x509-ca-cert", "cache-control": "no-store" },
        });
      } catch (error) {
        log?.error?.("setup: could not read ca.crt", error);
        return new Response("Not found", { status: 404 });
      }
    }
    return new Response("Not found", { status: 404 });
  };
}

function logger(log) {
  return {
    error(message, error) {
      try {
        log?.error?.(message, error);
      } catch {}
    },
  };
}

export async function createRuntime({ config, dataDir = DATA_DIR, desktop = null, log = console } = {}) {
  if (!config) throw new TypeError("config is required");
  if (
    typeof config.pairingSecret !== "string"
    || config.pairingSecret.length < 20
  ) {
    throw new TypeError("a usable pairing secret is required");
  }

  const safeLog = logger(log);
  const socketPath = join(dataDir, ADMIN_SOCKET);
  await rm(socketPath, { force: true });

  const audit = createAuditLog({ dataDir, log });
  const devices = createDeviceStore({ dataDir, log });
  const pairing = createPairing({ dataDir, secret: config.pairingSecret });
  const seen = createSeenStore({ dataDir });
  const push = createPush({ dataDir, vapid: config.vapid, log });
  const desktopPort = desktop ?? createDesktop({ log });

  let notifications = null;
  const fleet = createFleet({
    config,
    log,
    onChange: async (link) => {
      if (notifications) await notifications.announce(link);
    },
  });
  notifications = createNotifications({
    fleet,
    seen,
    push,
    devices,
    desktop: desktopPort,
    audit,
    log,
  });

  const app = createAppV2({
    config,
    fleet,
    push,
    pairing,
    devices,
    notifications,
    audit,
    dataDir,
    log,
  });
  const admin = createAdmin({
    socketPath,
    config,
    devices,
    pairing,
    push,
    fleet,
    audit,
    log,
  });

  await Promise.all([
    audit.init?.(),
    devices.init(),
    pairing.init(),
    seen.init(),
    push.init?.(),
  ]);

  let started = false;
  let stopPromise = null;

  async function attempt(label, operation) {
    try {
      await operation();
    } catch (error) {
      safeLog.error(`runtime: ${label} cleanup failed`, error);
    }
  }

  async function start() {
    if (started) return;
    if (stopPromise) throw new Error("runtime has already been stopped");
    try {
      await fleet.init();
      await fleet.start();
      await admin.start();
      started = true;
    } catch (error) {
      await stop();
      throw error;
    }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      await attempt("admin", () => admin.stop());
      await attempt("fleet", () => fleet.stop());
      await attempt("desktop", () => desktopPort.stop?.());
      await attempt("admin socket", () => rm(socketPath, { force: true }));
    })();
    return stopPromise;
  }

  return {
    config,
    dataDir,
    audit,
    devices,
    pairing,
    seen,
    push,
    desktop: desktopPort,
    fleet,
    notifications,
    app,
    admin,
    start,
    stop,
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    try {
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve(server.address());
      });
    } catch (error) {
      server.off("error", onError);
      reject(error);
    }
  });
}

function close(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function stopHandle(server, setupServer, runtime) {
  let stopPromise = null;
  return function stop() {
    if (!stopPromise) {
      stopPromise = (async () => {
        await close(setupServer);
        await close(server);
        await runtime.stop();
      })();
    }
    return stopPromise;
  };
}

export async function start({ config = null, dataDir = DATA_DIR, log = console } = {}) {
  const loaded = config ?? await loadConfigV2(dataDir);
  const runtime = await createRuntime({ config: loaded, dataDir, log });

  let server = null;
  let setupServer = null;
  try {
    await runtime.start();

    if (loaded.mode === "proxy") {
      server = createHttpServer(toNodeHandler(runtime.app.handler, { log }));
      const address = await listen(server, loaded.httpPort, loaded.host);
      return {
        config: loaded,
        runtime,
        server,
        setupServer: null,
        port: address.port,
        setupPort: null,
        stop: stopHandle(server, setupServer, runtime),
      };
    }

    const tls = await readTls(dataDir);
    server = createHttpsServer(tls, toNodeHandler(runtime.app.handler, { log }));
    setupServer = createHttpServer(toNodeHandler(createLanSetupHandler({ dataDir, log }), { log }));
    const address = await listen(server, loaded.httpsPort, loaded.host);
    const setupAddress = await listen(setupServer, loaded.setupPort, loaded.host);
    return {
      config: loaded,
      runtime,
      server,
      setupServer,
      port: address.port,
      setupPort: setupAddress.port,
      stop: stopHandle(server, setupServer, runtime),
    };
  } catch (error) {
    await close(setupServer);
    await close(server);
    await runtime.stop();
    throw error;
  }
}
