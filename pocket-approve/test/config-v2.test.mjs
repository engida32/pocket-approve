import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function tempData(prefix = "pa-config-v2-") {
  return mkdtemp(join(tmpdir(), prefix));
}

test("normalizes a proxy config with two explicit servers", async () => {
  const { normalizeConfig } = await import("../lib/config-v2.mjs?" + Date.now());
  const config = normalizeConfig({
    mode: "proxy",
    host: "127.0.0.1",
    publicOrigin: "https://approve.example.com",
    servers: [
      { id: "local", label: "This laptop", url: "http://127.0.0.1:4096" },
      { id: "work", label: "Work box", url: "https://work.example.com", passwordEnv: "WORK_PW" },
    ],
  });
  assert.equal(config.mode, "proxy");
  assert.equal(config.httpPort, 8080);
  assert.equal(config.servers.length, 2);
  assert.equal(config.servers[0].username, "opencode");
  assert.equal(config.servers[0].password, null);
  assert.equal(config.servers[1].passwordEnv, "WORK_PW");
  assert.equal(config.allowLegacyToken, false);
  assert.equal(config.pollIntervalMs, 3000);
});

test("rejects wildcard proxy binds and non-loopback proxy hosts", async () => {
  const { normalizeConfig } = await import("../lib/config-v2.mjs?" + Date.now());
  for (const host of ["0.0.0.0", "::", "192.168.1.5"]) {
    assert.throws(
      () => normalizeConfig({
        host,
        publicOrigin: "https://approve.example.com",
        servers: [{ id: "local", url: "http://127.0.0.1:4096" }],
      }),
      /loopback/i,
      host,
    );
  }
});

test("rejects an invalid proxy httpPort", async () => {
  const { normalizeConfig } = await import("../lib/config-v2.mjs?" + Date.now());
  const base = {
    host: "127.0.0.1",
    publicOrigin: "https://approve.example.com",
    servers: [{ id: "local", url: "http://127.0.0.1:4096" }],
  };
  for (const httpPort of [0, 65_536, 1.5, "8080"]) {
    assert.throws(() => normalizeConfig({ ...base, httpPort }), /httpPort/i, String(httpPort));
  }
  assert.equal(normalizeConfig({ ...base, httpPort: 1 }).httpPort, 1);
  assert.equal(normalizeConfig({ ...base, httpPort: 65_535 }).httpPort, 65_535);
});

test("rejects credentials, paths, queries, fragments, and non-loopback plain HTTP", async () => {
  const { normalizeConfig } = await import("../lib/config-v2.mjs?" + Date.now());
  const base = { host: "127.0.0.1", publicOrigin: "https://approve.example.com" };
  for (const url of [
    "https://user:pw@example.com",
    "https://example.com/path",
    "https://example.com?x=1",
    "https://example.com#x",
    "http://192.168.1.5:4096",
  ]) {
    assert.throws(
      () => normalizeConfig({ ...base, servers: [{ id: "a", url }] }),
      /server url/i,
      url,
    );
  }
  const local = normalizeConfig({ ...base, servers: [{ id: "a", url: "http://localhost:4096" }] });
  assert.equal(local.servers[0].url, "http://localhost:4096");
});

test("rejects duplicate ids, a colon in ids, bad labels, and both password forms", async () => {
  const { normalizeConfig } = await import("../lib/config-v2.mjs?" + Date.now());
  const base = { host: "127.0.0.1", publicOrigin: "https://approve.example.com" };
  const bad = [
    [{ id: "a", url: "http://127.0.0.1:1" }, { id: "a", url: "http://127.0.0.1:2" }],
    [{ id: "a:b", url: "http://127.0.0.1:1" }],
    [{ id: "a", label: "x".repeat(33), url: "http://127.0.0.1:1" }],
    [{ id: "a", url: "http://127.0.0.1:1", password: "p", passwordEnv: "P" }],
  ];
  for (const servers of bad) {
    assert.throws(() => normalizeConfig({ ...base, servers }), /server/i);
  }
});

test("migrates legacy fields only when servers are absent", async () => {
  const { normalizeConfig } = await import("../lib/config-v2.mjs?" + Date.now());
  const migrated = normalizeConfig({
    host: "192.168.1.5",
    opencodeUrl: "http://127.0.0.1:4096",
    opencodePassword: "pw",
  });
  assert.equal(migrated.mode, "lan");
  assert.deepEqual(migrated.servers, [{
    id: "default",
    label: "OpenCode",
    url: "http://127.0.0.1:4096",
    username: "opencode",
    password: "pw",
    passwordEnv: null,
    directory: null,
    enabled: true,
  }]);
  assert.equal(migrated.allowLegacyToken, true);

  const explicit = normalizeConfig({
    host: "192.168.1.5",
    opencodeUrl: "http://127.0.0.1:9999",
    servers: [{ id: "a", url: "http://127.0.0.1:4096" }],
  });
  assert.equal(explicit.servers.length, 1);
  assert.equal(explicit.servers[0].url, "http://127.0.0.1:4096");
});

test("saveConfigV2 writes a private file and loadConfigV2 round-trips", async () => {
  const dir = await tempData();
  process.env.POCKET_APPROVE_DATA = dir;
  const { saveConfigV2, loadConfigV2 } = await import("../lib/config-v2.mjs?" + Date.now());
  await saveConfigV2({
    host: "127.0.0.1",
    publicOrigin: "https://approve.example.com",
    servers: [{ id: "local", url: "http://127.0.0.1:4096" }],
  });
  const file = join(dir, "config.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const loaded = await loadConfigV2();
  assert.equal(loaded.mode, "proxy");
  assert.equal(loaded.servers[0].id, "local");
  assert.equal(JSON.parse(await readFile(file, "utf8")).mode, "proxy");
});

test("an empty or disabled-only fleet fails startup", async () => {
  const { normalizeConfig } = await import("../lib/config-v2.mjs?" + Date.now());
  const base = { host: "127.0.0.1", publicOrigin: "https://approve.example.com" };
  assert.throws(() => normalizeConfig({ ...base, servers: [] }), /at least one server/i);
  assert.throws(
    () => normalizeConfig({ ...base, servers: [{ id: "a", url: "http://127.0.0.1:1", enabled: false }] }),
    /at least one server/i,
  );
});

test("brackets IPv6 LAN hosts and keeps the bind host bare", async () => {
  const { normalizeConfig } = await import("../lib/config-v2.mjs?" + Date.now());
  const base = {
    mode: "lan",
    servers: [{ id: "a", url: "http://127.0.0.1:4096" }],
  };
  const bare = normalizeConfig({ ...base, host: "fd00::5" });
  assert.equal(bare.host, "fd00::5");
  assert.equal(bare.publicOrigin, "https://[fd00::5]:8443");

  const bracketed = normalizeConfig({ ...base, host: "[fd00::5]", httpsPort: 9443 });
  assert.equal(bracketed.host, "fd00::5");
  assert.equal(bracketed.publicOrigin, "https://[fd00::5]:9443");

  const local = normalizeConfig({ ...base, host: "::1" });
  assert.equal(local.host, "::1");
  assert.equal(local.publicOrigin, "https://[::1]:8443");
});

test("rejects a LAN host that already includes a port", async () => {
  const { normalizeConfig } = await import("../lib/config-v2.mjs?" + Date.now());
  const base = {
    mode: "lan",
    servers: [{ id: "a", url: "http://127.0.0.1:4096" }],
  };
  for (const host of ["192.168.1.5:8443", "example.com:8443", "[::1]:8443"]) {
    assert.throws(() => normalizeConfig({ ...base, host }), /port/i, host);
  }
});

test("validates LAN httpsPort and setupPort", async () => {
  const { normalizeConfig } = await import("../lib/config-v2.mjs?" + Date.now());
  const base = {
    mode: "lan",
    host: "192.168.1.5",
    servers: [{ id: "a", url: "http://127.0.0.1:4096" }],
  };
  for (const key of ["httpsPort", "setupPort"]) {
    for (const value of [0, 65_536, 1.5, "8443"]) {
      assert.throws(
        () => normalizeConfig({ ...base, [key]: value }),
        new RegExp(key, "i"),
        `${key}=${value}`,
      );
    }
  }
  const edges = normalizeConfig({ ...base, httpsPort: 1, setupPort: 65_535 });
  assert.equal(edges.httpsPort, 1);
  assert.equal(edges.setupPort, 65_535);
});

test("CONFIG_V2_PATH and load/save follow the data directory after the env changes", async () => {
  const previous = process.env.POCKET_APPROVE_DATA;
  const dirA = await tempData("pa-config-v2-a-");
  const dirB = await tempData("pa-config-v2-b-");
  try {
    process.env.POCKET_APPROVE_DATA = dirA;
    const module = await import("../lib/config-v2.mjs?" + Date.now());
    assert.equal(module.CONFIG_V2_PATH, join(dirA, "config.json"));

    process.env.POCKET_APPROVE_DATA = dirB;
    const saved = await module.saveConfigV2({
      host: "127.0.0.1",
      publicOrigin: "https://approve.example.com",
      servers: [{ id: "local", url: "http://127.0.0.1:4096" }],
    });
    assert.equal(module.CONFIG_V2_PATH, join(dirB, "config.json"));
    assert.equal(saved.mode, "proxy");
    assert.equal((await stat(join(dirB, "config.json"))).mode & 0o777, 0o600);
    assert.equal((await module.loadConfigV2()).servers[0].id, "local");
  } finally {
    if (previous === undefined) delete process.env.POCKET_APPROVE_DATA;
    else process.env.POCKET_APPROVE_DATA = previous;
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("rejects mistyped enabled, trustProxy, and directory fields", async () => {
  const { normalizeConfig } = await import("../lib/config-v2.mjs?" + Date.now());
  const base = {
    host: "127.0.0.1",
    publicOrigin: "https://approve.example.com",
    servers: [{ id: "a", url: "http://127.0.0.1:1" }],
  };
  assert.throws(
    () => normalizeConfig({ ...base, servers: [{ id: "a", url: "http://127.0.0.1:1", enabled: "yes" }] }),
    /enabled/i,
  );
  assert.throws(
    () => normalizeConfig({ ...base, servers: [{ id: "a", url: "http://127.0.0.1:1", enabled: 0 }] }),
    /enabled/i,
  );
  assert.throws(() => normalizeConfig({ ...base, trustProxy: "true" }), /trustProxy/i);
  assert.throws(
    () => normalizeConfig({ ...base, servers: [{ id: "a", url: "http://127.0.0.1:1", directory: 7 }] }),
    /directory/i,
  );
  const ok = normalizeConfig({
    ...base,
    trustProxy: false,
    servers: [{ id: "a", url: "http://127.0.0.1:1", directory: "/work", enabled: true }],
  });
  assert.equal(ok.trustProxy, false);
  assert.equal(ok.servers[0].directory, "/work");
});

test("normalizes bracketed loopback proxy hosts to the bindable bare form", async () => {
  const { normalizeConfig } = await import("../lib/config-v2.mjs?" + Date.now());
  const base = {
    mode: "proxy",
    publicOrigin: "https://approve.example.com",
    servers: [{ id: "local", url: "http://127.0.0.1:4096" }],
  };
  const ipv6 = normalizeConfig({ ...base, host: "[::1]" });
  assert.equal(ipv6.host, "::1");
  assert.equal(ipv6.publicOrigin, "https://approve.example.com");

  const ipv4 = normalizeConfig({ ...base, host: "[127.0.0.1]" });
  assert.equal(ipv4.host, "127.0.0.1");

  assert.throws(
    () => normalizeConfig({ ...base, host: "[192.168.1.5]" }),
    /loopback/i,
  );
});
