import { DATA_DIR } from "./config.mjs";
import { createAuditLog } from "./audit.mjs";
import { createSeenStore } from "./seen.mjs";
import { createDesktop } from "./desktop.mjs";
import { createFleet } from "./fleet.mjs";
import { createNtfy } from "./ntfy.mjs";
import { createNotifications } from "./notifications.mjs";

export function createNtfyRuntime({
  servers,
  pollIntervalMs = 3000,
  dataDir = DATA_DIR,
  settings,
  allowAlways = true,
  desktop = null,
  log = console,
  fetchImpl = fetch,
  now,
  deps = {},
} = {}) {
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new TypeError("servers must be a non-empty array");
  }
  if (!settings) throw new TypeError("settings is required");
  const {
    createAuditLog: makeAudit = createAuditLog,
    createSeenStore: makeSeen = createSeenStore,
    createDesktop: makeDesktop = createDesktop,
    createFleet: makeFleet = createFleet,
    createNtfy: makeNtfy = createNtfy,
    createNotifications: makeNotifications = createNotifications,
  } = deps;

  const audit = makeAudit({ dataDir, log });
  const seen = makeSeen({ dataDir, now });
  const desktopPort = desktop ?? makeDesktop({ log });
  let notifications = null;
  const fleet = makeFleet({
    config: { servers, pollIntervalMs },
    log,
    now,
    onChange: async (link) => {
      if (notifications) await notifications.announce(link);
    },
  });
  const ntfy = makeNtfy({
    settings,
    dataDir,
    audit,
    fleet,
    allowAlways,
    log,
    fetchImpl,
    now,
    onReply: (id) => desktopPort.close(id),
  });
  notifications = makeNotifications({
    fleet,
    seen,
    desktop: desktopPort,
    audit,
    ntfy,
    digest: false,
    log,
  });

  return {
    audit,
    seen,
    desktop: desktopPort,
    fleet,
    ntfy,
    notifications,
    async init() {
      await audit.init?.();
      await seen.init();
      await fleet.init();
    },
    async start() {
      await fleet.start();
      await ntfy.start();
    },
    async stop() {
      await ntfy.stop();
      await fleet.stop();
      await desktopPort.stop?.();
    },
  };
}
