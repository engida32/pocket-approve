import test from "node:test";
import assert from "node:assert/strict";
import { createNtfyRuntime } from "../lib/ntfy-runtime.mjs";

test("createNtfyRuntime wires only the browserless dependencies", async () => {
  const events = [];
  const notifications = { announce: async (link) => events.push(["announce", link.id]) };
  const deps = {
    createAuditLog: () => ({ append() {} }),
    createSeenStore: () => ({ init: async () => events.push(["seen.init"]), observe: async () => {}, takeNew: async () => [], release: async () => {} }),
    createDesktop: () => ({ notify: async () => null, stop: () => events.push(["desktop.stop"]) }),
    createFleet: ({ onChange }) => ({
      init: async () => events.push(["fleet.init"]),
      start: async () => events.push(["fleet.start"]),
      stop: async () => events.push(["fleet.stop"]),
      pending: async () => ({ requests: [] }),
      reply: async () => ({ status: 200 }),
      emit: onChange,
    }),
    createNtfy: () => ({ start: async () => events.push(["ntfy.start"]), stop: async () => events.push(["ntfy.stop"]) }),
    createNotifications: () => notifications,
  };
  const runtime = createNtfyRuntime({
    servers: [{ id: "alpha", label: "Alpha", url: "http://127.0.0.1:4096", enabled: true, username: "opencode", password: null, directory: null }],
    dataDir: "/tmp/unused",
    settings: { baseUrl: "https://ntfy.sh", outTopic: "out", replyTopic: "reply", secret: "x".repeat(43) },
    deps,
  });
  await runtime.init();
  await runtime.start();
  await runtime.fleet.emit({ id: "alpha" });
  await runtime.stop();
  assert.deepEqual(events, [
    ["seen.init"],
    ["fleet.init"],
    ["fleet.start"],
    ["ntfy.start"],
    ["announce", "alpha"],
    ["ntfy.stop"],
    ["fleet.stop"],
    ["desktop.stop"],
  ]);
});

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("the CLI prints usage for --help", () => {
  const script = fileURLToPath(new URL("../scripts/ntfy.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--disconnect/);
  assert.match(result.stdout, /--rotate/);
});
