import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPairing, formatPairCode, normalizePairCode } from "../lib/pairing.mjs";

const SECRET = Buffer.alloc(32, 7).toString("base64url");

async function dir(t) {
  const value = await mkdtemp(join(tmpdir(), "pa-pairing-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

test("code format is unambiguous and normalized", () => {
  assert.equal(normalizePairCode(" abcd-efgh "), "ABCDEFGH");
  assert.equal(formatPairCode("ABCDEFGH"), "ABCD-EFGH");
});

test("a valid code is single use and clearing happens after the handler", async (t) => {
  let clock = Date.parse("2026-10-25T12:00:00Z");
  const pairing = createPairing({
    dataDir: await dir(t),
    secret: SECRET,
    now: () => new Date(clock),
  });
  await pairing.init();
  const { code, expiresAt } = await pairing.open("Ada");
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(expiresAt, "2026-10-25T12:10:00.000Z");
  let calls = 0;
  const first = await pairing.redeem(code, async ({ label }) => {
    calls += 1;
    assert.equal(label, "Ada");
  });
  assert.deepEqual(first, { ok: true, label: "Ada" });
  assert.equal(calls, 1);
  const second = await pairing.redeem(code, async () => { calls += 1; });
  assert.deepEqual(second, { ok: false, reason: "missing" });
  assert.equal(calls, 1);
});

test("a failed handler leaves the code usable", async (t) => {
  const pairing = createPairing({ dataDir: await dir(t), secret: SECRET });
  await pairing.init();
  const { code } = await pairing.open("Phone");
  await assert.rejects(pairing.redeem(code, async () => {
    throw new Error("disk full");
  }), /disk full/);
  const ok = await pairing.redeem(code, async () => {});
  assert.equal(ok.ok, true);
});

test("expiry, five wrong attempts, and replacement invalidate a code", async (t) => {
  let clock = Date.parse("2026-10-25T12:00:00Z");
  const pairing = createPairing({ dataDir: await dir(t), secret: SECRET, now: () => new Date(clock) });
  await pairing.init();
  const first = await pairing.open("One");
  const second = await pairing.open("Two");
  assert.deepEqual(await pairing.redeem(first.code, async () => {}), { ok: false, reason: "missing" });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await pairing.redeem("AAAA-AAAA", async () => {})).reason, "bad_code");
  }
  assert.deepEqual(await pairing.redeem(second.code, async () => {}), { ok: false, reason: "locked" });
  const third = await pairing.open("Three");
  clock += 10 * 60 * 1000 + 1;
  assert.deepEqual(await pairing.redeem(third.code, async () => {}), { ok: false, reason: "expired" });
});
