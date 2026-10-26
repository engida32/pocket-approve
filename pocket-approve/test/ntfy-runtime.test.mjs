import test from "node:test";
import assert from "node:assert/strict";
import { createNtfyRuntime } from "../lib/ntfy-runtime.mjs";
import {
  directoriesFromSessions,
  discoverSessions,
  serversForDirectories,
} from "../scripts/ntfy.mjs";

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

test("discoverSessions requests the session list with the expected options", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => [{ directory: "/work/alpha" }] };
  };
  const sessions = await discoverSessions({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
  assert.deepEqual(sessions, [{ directory: "/work/alpha" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:4096/session?limit=1000");
  assert.equal(calls[0].init.headers.accept, "application/json");
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.signal.aborted, false);
});

test("discoverSessions rejects invalid origins and non-array payloads", async () => {
  await assert.rejects(
    discoverSessions({ baseUrl: "http://127.0.0.1:4096/path", fetchImpl: async () => ({}) }),
    /must be an origin/,
  );
  await assert.rejects(
    discoverSessions({ baseUrl: "http://user:pass@127.0.0.1:4096", fetchImpl: async () => ({}) }),
    /must not include credentials/,
  );
  await assert.rejects(
    discoverSessions({
      baseUrl: "http://127.0.0.1:4096",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ not: "an array" }) }),
    }),
    /unexpected session list/,
  );
});

test("directoriesFromSessions filters, dedupes, sorts, and caps", () => {
  const sessions = [
    { directory: "/beta", time: { updated: 10 } },
    { directory: "relative/ignored", time: { updated: 999 } },
    { directory: "/alpha", time: { updated: 20 } },
    { directory: "/gamma", time: { updated: 20 } },
    { directory: "/beta", time: { updated: 50 } },
    { directory: "/delta", time: { updated: 5 } },
  ];
  assert.deepEqual(directoriesFromSessions(sessions), ["/beta", "/alpha", "/gamma", "/delta"]);
  assert.deepEqual(directoriesFromSessions(sessions, 3), ["/beta", "/alpha", "/gamma"]);
});

test("serversForDirectories hashes ids deterministically and falls back locally", () => {
  const url = "http://127.0.0.1:4096";
  const servers = serversForDirectories(["/work/alpha", "/work/beta", "/work/alpha"], { url });
  assert.deepEqual(servers.map((server) => server.label), ["alpha", "beta"]);
  assert.equal(servers[0].directory, "/work/alpha");
  assert.equal(servers[0].url, url);
  assert.match(servers[0].id, /^alpha-[0-9a-f]{8}$/);
  const repeat = serversForDirectories(["/work/alpha"], { url });
  assert.equal(repeat[0].id, servers[0].id);
  assert.notEqual(servers[0].id, servers[1].id);
  assert.deepEqual(serversForDirectories([], { url }), [
    { id: "local", label: "OpenCode", url, directory: null },
  ]);
});

test("serversForDirectories caps at 50 servers", () => {
  const directories = Array.from({ length: 51 }, (_, index) => `/work/project-${index}`);
  const servers = serversForDirectories(directories, { url: "http://127.0.0.1:4096" });
  assert.equal(servers.length, 50);
});
