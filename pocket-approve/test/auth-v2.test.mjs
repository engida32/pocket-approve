import test from "node:test";
import assert from "node:assert/strict";
import { createAuthenticator, expectedOrigin, originAllowed } from "../lib/device-auth.mjs";
import { createRateLimiter } from "../lib/rate-limit.mjs";

function devices(record) {
  return {
    findActive: async (token) => token === "device-token" ? record : null,
    touch: async () => {},
  };
}

test("device auth wins and reports the device", async () => {
  const auth = createAuthenticator({ devices: devices({ id: "dev_1" }) });
  const result = await auth.authenticate({ headers: { authorization: "Bearer device-token" } });
  assert.equal(result.device.id, "dev_1");
  assert.equal(await auth.authenticate({ headers: { authorization: "Bearer nope" } }), null);
});

test("legacy token is only accepted when the flag and value are present", async () => {
  const enabled = createAuthenticator({
    devices: devices({ id: "dev_1" }),
    allowLegacyToken: true,
    legacyToken: "old",
  });
  assert.deepEqual(await enabled.authenticate({ headers: { authorization: "Bearer old" } }), { legacy: true });
  const disabled = createAuthenticator({
    devices: devices({ id: "dev_1" }),
    allowLegacyToken: false,
    legacyToken: "old",
  });
  assert.equal(await disabled.authenticate({ headers: { authorization: "Bearer old" } }), null);
});

test("proxy origin is exact and an absent origin is rejected", () => {
  const config = { mode: "proxy", publicOrigin: "https://approve.example.com", host: "127.0.0.1", httpsPort: 8443 };
  assert.equal(expectedOrigin(config), "https://approve.example.com");
  assert.equal(originAllowed({ headers: { origin: "https://approve.example.com" } }, config), true);
  assert.equal(originAllowed({ headers: { origin: "https://evil.example.com" } }, config), false);
  assert.equal(originAllowed({ headers: {} }, config), false);
  const lan = { ...config, mode: "lan", host: "192.168.1.5", httpsPort: 8443, publicOrigin: undefined };
  assert.equal(expectedOrigin(lan), "https://192.168.1.5:8443");
});

test("rate limits return a retry delay and reset after the window", () => {
  let clock = 0;
  const limiter = createRateLimiter({ now: () => clock });
  assert.equal(limiter.take("a", 2, 60_000), 0);
  assert.equal(limiter.take("a", 2, 60_000), 0);
  assert.equal(limiter.take("a", 2, 60_000), 60);
  clock = 60_001;
  assert.equal(limiter.take("a", 2, 60_000), 0);
});

test("sweeps expired buckets once the map grows", () => {
  let clock = 0;
  const limiter = createRateLimiter({ now: () => clock });
  for (let i = 0; i < 1100; i += 1) limiter.take(`k${i}`, 1, 1000);
  assert.equal(limiter.size(), 1100);
  clock = 2000;
  assert.equal(limiter.take("fresh", 1, 1000), 0);
  assert.equal(limiter.size(), 1);
});

test("lan origin prefers the normalized publicOrigin over naive construction", () => {
  const config = {
    mode: "lan",
    host: "fd00::5",
    httpsPort: 8443,
    publicOrigin: "https://[fd00::5]:8443",
  };
  assert.equal(expectedOrigin(config), "https://[fd00::5]:8443");
  assert.equal(originAllowed({ headers: { origin: "https://[fd00::5]:8443" } }, config), true);
});

test("origin must match the scheme and port exactly", () => {
  const config = { mode: "proxy", publicOrigin: "https://approve.example.com", host: "127.0.0.1", httpsPort: 8443 };
  assert.equal(originAllowed({ headers: { origin: "http://approve.example.com" } }, config), false);
  assert.equal(originAllowed({ headers: { origin: "https://approve.example.com:8443" } }, config), false);
  assert.equal(originAllowed({ headers: { origin: "https://approve.example.com/" } }, config), false);
});

test("legacy token comparison is exact, case-sensitive, and requires a string", async () => {
  const auth = createAuthenticator({
    devices: devices({ id: "dev_1" }),
    allowLegacyToken: true,
    legacyToken: "Old-Token",
  });
  assert.deepEqual(await auth.authenticate({ headers: { authorization: "Bearer Old-Token" } }), { legacy: true });
  assert.equal(await auth.authenticate({ headers: { authorization: "Bearer old-token" } }), null);
  assert.equal(await auth.authenticate({ headers: { authorization: "Bearer Old-Token-extra" } }), null);
  assert.equal(await auth.authenticate({ headers: { authorization: "Bearer Old" } }), null);
  const nonString = createAuthenticator({
    devices: devices({ id: "dev_1" }),
    allowLegacyToken: true,
    legacyToken: 123,
  });
  assert.equal(await nonString.authenticate({ headers: { authorization: "Bearer 123" } }), null);
});

test("rate-limit buckets are isolated per key", () => {
  let clock = 0;
  const limiter = createRateLimiter({ now: () => clock });
  assert.equal(limiter.take("a", 1, 1000), 0);
  assert.equal(limiter.take("b", 1, 1000), 0);
  assert.equal(limiter.take("a", 1, 1000), 1);
  assert.equal(limiter.take("b", 1, 1000), 1);
});

test("rate limits reject invalid limit and window arguments", () => {
  const limiter = createRateLimiter({ now: () => 0 });
  const invalid = [
    [0, 1000],
    [-1, 1000],
    [1.5, 1000],
    ["1", 1000],
    [1, 0],
    [1, -1],
    [1, 1000.5],
    [1, "1000"],
  ];
  for (const [limit, windowMs] of invalid) {
    assert.throws(() => limiter.take("k", limit, windowMs), TypeError, `${limit}/${windowMs}`);
  }
});

test("a failing last-seen write does not invalidate authentication", async () => {
  const auth = createAuthenticator({
    devices: {
      findActive: async () => ({ id: "dev_1" }),
      touch: async () => {
        throw new Error("disk full");
      },
    },
  });
  const result = await auth.authenticate({ headers: { authorization: "Bearer device-token" } });
  assert.equal(result.device.id, "dev_1");
});

test("authenticate does not expose the stored token hash", async () => {
  const record = { id: "dev_1", name: "Phone", tokenHash: "sha256:secret" };
  const auth = createAuthenticator({ devices: devices(record) });
  const result = await auth.authenticate({ headers: { authorization: "Bearer device-token" } });
  assert.equal(result.device.id, "dev_1");
  assert.equal(result.device.name, "Phone");
  assert.equal("tokenHash" in result.device, false);
  assert.equal(record.tokenHash, "sha256:secret");
});
