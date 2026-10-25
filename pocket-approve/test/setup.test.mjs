import test from "node:test";
import assert from "node:assert/strict";
import { chooseHost, detectLanIp } from "../scripts/setup.mjs";

test("live detection beats a stale saved host", () => {
  assert.equal(
    chooseHost({ detectedIp: "198.51.100.7", savedHost: "192.0.2.10" }),
    "198.51.100.7",
  );
});

test("explicit host beats detection and the saved host", () => {
  assert.equal(
    chooseHost({
      explicitHost: "203.0.113.5",
      detectedIp: "198.51.100.7",
      savedHost: "192.0.2.10",
    }),
    "203.0.113.5",
  );
});

test("saved host is only a fallback when detection finds nothing", () => {
  assert.equal(
    chooseHost({ detectedIp: null, savedHost: "192.0.2.10" }),
    "192.0.2.10",
  );
  assert.equal(chooseHost({}), null);
});

test("detection skips internal and container addresses", () => {
  const interfaces = {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
    "br-x": [{ address: "192.168.122.1", family: "IPv4", internal: false }],
    wlan0: [{ address: "198.51.100.7", family: "IPv4", internal: false }],
    eth0: [{ address: "10.1.2.3", family: "IPv4", internal: false }],
  };
  assert.equal(detectLanIp(interfaces), "10.1.2.3");
});
