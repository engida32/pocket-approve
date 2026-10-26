import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  buildSetupArgs,
  directoriesFromSessions,
  discoverSessions,
  pairingUrl,
  parsePhoneArgs,
  sameServers,
  serverIdFor,
  serversForDirectories,
} from "../lib/phone.mjs";

const SERVER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

test("parses phone flags and defaults", () => {
  assert.deepEqual(parsePhoneArgs([]), {
    host: null,
    opencode: "http://127.0.0.1:4096",
    label: "Phone",
    qr: true,
    help: false,
  });
  const options = parsePhoneArgs([
    "--host", "192.168.1.5",
    "--opencode=http://127.0.0.1:5000",
    "--label", "  My phone  ",
    "--no-qr",
  ]);
  assert.equal(options.host, "192.168.1.5");
  assert.equal(options.opencode, "http://127.0.0.1:5000");
  assert.equal(options.label, "My phone");
  assert.equal(options.qr, false);
});

test("rejects bad phone flags", () => {
  assert.throws(() => parsePhoneArgs(["--opencode", "http://127.0.0.1:4096/api"]), /origin/);
  assert.throws(() => parsePhoneArgs(["--opencode", "ftp://127.0.0.1:4096"]), /http or https/);
  assert.throws(() => parsePhoneArgs(["--label", "   "]), /between 1 and 64/);
  assert.throws(() => parsePhoneArgs(["--nope"]), /unknown argument/);
});

test("collects unique absolute session directories, most recent first, capped", () => {
  const sessions = [
    { directory: "/work/a", time: { updated: 10 } },
    { directory: "/work/b", time: { updated: 30 } },
    { directory: "/work/a", time: { updated: 20 } },
    { directory: "relative/path", time: { updated: 99 } },
    { directory: "/work/c" },
    null,
  ];
  assert.deepEqual(directoriesFromSessions(sessions), ["/work/b", "/work/a", "/work/c"]);
  assert.deepEqual(directoriesFromSessions(sessions, 2), ["/work/b", "/work/a"]);
});

test("builds stable valid server ids and labels", () => {
  const servers = serversForDirectories(["/home/me/OpenCode Workspace", "/home/me/research-v2"]);
  assert.equal(servers.length, 2);
  for (const server of servers) {
    assert.match(server.id, SERVER_ID);
    assert.equal(server.url, "http://127.0.0.1:4096");
    assert.ok(server.directory.startsWith("/home/me/"));
  }
  assert.equal(servers[0].label, "OpenCode Workspace");
  assert.equal(servers[1].label, "research-v2");
  assert.equal(serverIdFor("/home/me/research-v2"), serverIdFor("/home/me/research-v2"));
  assert.notEqual(serverIdFor("/home/me/research-v2"), serverIdFor("/home/me/research-v3"));
});

test("falls back to one default server when no directories are known", () => {
  assert.deepEqual(serversForDirectories([]), [
    { id: "local", label: "OpenCode", url: "http://127.0.0.1:4096", directory: null },
  ]);
});

test("compares server lists without depending on order", () => {
  const left = [
    { id: "a", label: "A", url: "http://127.0.0.1:4096", directory: "/a" },
    { id: "b", label: "B", url: "http://127.0.0.1:4096", directory: "/b" },
  ];
  assert.equal(sameServers(left, [...left].reverse()), true);
  assert.equal(sameServers(left, [{ ...left[0] }, { ...left[1], directory: "/c" }]), false);
  assert.equal(sameServers(left, [{ ...left[0] }, { ...left[1], password: "secret" }]), false);
});

test("builds setup arguments with directories and force", () => {
  const args = buildSetupArgs({
    host: "192.168.1.5",
    servers: [
      { id: "local", url: "http://127.0.0.1:4096", directory: null },
      { id: "work", label: "Work", url: "http://127.0.0.1:4096", directory: "/work" },
    ],
    force: true,
  });
  assert.deepEqual(args, [
    "--mode", "lan",
    "--host", "192.168.1.5",
    "--server", "local=http://127.0.0.1:4096",
    "--server", "work=http://127.0.0.1:4096",
    "--server-label", "work=Work",
    "--server-dir", "work=/work",
    "--no-qr",
    "--force",
  ]);
});

test("builds a pairing URL in the fragment", () => {
  assert.equal(
    pairingUrl("https://192.168.1.5:8443/", "ABCD-EFGH"),
    "https://192.168.1.5:8443/pair#code=ABCD-EFGH",
  );
  assert.equal(
    pairingUrl("https://192.168.1.5:8443/", "ABCD-EFGH", "Ada's iPhone"),
    "https://192.168.1.5:8443/pair#code=ABCD-EFGH&label=Ada%27s+iPhone",
  );
});

test("discovers sessions from the OpenCode API", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([{ id: "ses_1", directory: "/work", time: { updated: 1 } }]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const sessions = await discoverSessions({ baseUrl });
  assert.deepEqual(sessions, [{ id: "ses_1", directory: "/work", time: { updated: 1 } }]);
  assert.deepEqual(requests, ["/session?limit=1000"]);
});

test("reports OpenCode discovery failures clearly", async (t) => {
  const server = createServer((request, response) => {
    response.statusCode = 500;
    response.end("nope");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  await assert.rejects(discoverSessions({ baseUrl }), /HTTP 500/);
  await assert.rejects(
    discoverSessions({ baseUrl: "http://127.0.0.1:1" }),
    /cannot reach OpenCode/,
  );
});
