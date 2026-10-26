import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPairing, formatPairCode, normalizePairCode } from "../lib/pairing.mjs";
import { writePrivateJson } from "../lib/store.mjs";

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

test("concurrent redeems consume the code once", async (t) => {
  const pairing = createPairing({ dataDir: await dir(t), secret: SECRET });
  await pairing.init();
  const { code } = await pairing.open("Concurrent");
  let calls = 0;
  const handler = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const results = await Promise.all([
    pairing.redeem(code, handler),
    pairing.redeem(code, handler),
    pairing.redeem(code, handler),
  ]);
  assert.equal(calls, 1);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(results.filter((item) => !item.ok && item.reason === "missing").length, 2);
});

test("a second instance can redeem a code opened by the first", async (t) => {
  const dataDir = await dir(t);
  const first = createPairing({ dataDir, secret: SECRET });
  await first.init();
  const { code } = await first.open("Shared");
  const second = createPairing({ dataDir, secret: SECRET });
  await second.init();
  assert.deepEqual(await second.redeem(code, async () => {}), { ok: true, label: "Shared" });
});

test("failed attempts survive a restart and lock the code", async (t) => {
  const dataDir = await dir(t);
  const first = createPairing({ dataDir, secret: SECRET });
  await first.init();
  const { code } = await first.open("Retry");
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await first.redeem("AAAA-AAAA", async () => {})).reason, "bad_code");
  }
  const second = createPairing({ dataDir, secret: SECRET });
  await second.init();
  assert.equal((await second.redeem("AAAA-AAAA", async () => {})).reason, "bad_code");
  assert.deepEqual(await second.redeem(code, async () => {}), { ok: false, reason: "locked" });
});

test("a locked code stays locked after a restart", async (t) => {
  const dataDir = await dir(t);
  const first = createPairing({ dataDir, secret: SECRET });
  await first.init();
  const { code } = await first.open("Locked");
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await first.redeem("AAAA-AAAA", async () => {})).reason, "bad_code");
  }
  const second = createPairing({ dataDir, secret: SECRET });
  await second.init();
  assert.deepEqual(await second.redeem(code, async () => {}), { ok: false, reason: "locked" });
});

test("the pairing record is private and stores no plaintext code", async (t) => {
  const dataDir = await dir(t);
  const pairing = createPairing({ dataDir, secret: SECRET });
  await pairing.init();
  const { code } = await pairing.open("Disk");
  const file = join(dataDir, "pairing.json");
  const raw = await readFile(file, "utf8");
  const saved = JSON.parse(raw);
  assert.deepEqual(Object.keys(saved).sort(), [
    "attempts",
    "createdAt",
    "expiresAt",
    "hash",
    "label",
    "salt",
    "state",
  ]);
  assert.equal(saved.state, "active");
  assert.equal(raw.includes(normalizePairCode(code)), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
});

test("a failed final write cannot revive a consumed code", async (t) => {
  const dataDir = await dir(t);
  const moved = `${dataDir}-moved`;
  t.after(() => rm(moved, { recursive: true, force: true }));
  const pairing = createPairing({ dataDir, secret: SECRET });
  await pairing.init();
  const { code } = await pairing.open("Crash");
  const result = await pairing.redeem(code, async () => {
    await rename(dataDir, moved);
    await writeFile(dataDir, "not a directory");
  });
  assert.deepEqual(result, { ok: true, label: "Crash" });
  await rm(dataDir, { force: true });
  await rename(moved, dataDir);
  const fresh = createPairing({ dataDir, secret: SECRET });
  await fresh.init();
  assert.deepEqual(await fresh.redeem(code, async () => {}), { ok: false, reason: "locked" });
});

test("a handler failure restores the code on disk", async (t) => {
  const dataDir = await dir(t);
  const pairing = createPairing({ dataDir, secret: SECRET });
  await pairing.init();
  const { code } = await pairing.open("Boom");
  await assert.rejects(
    pairing.redeem(code, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  const fresh = createPairing({ dataDir, secret: SECRET });
  await fresh.init();
  assert.deepEqual(await fresh.redeem(code, async () => {}), { ok: true, label: "Boom" });
});

test("malformed input does not burn attempts", async (t) => {
  const dataDir = await dir(t);
  const pairing = createPairing({ dataDir, secret: SECRET });
  await pairing.init();
  const { code } = await pairing.open("Malformed");
  for (const input of ["", null, "abc", "ABCD-EFG", 42]) {
    assert.deepEqual(await pairing.redeem(input, async () => {}), { ok: false, reason: "bad_code" });
  }
  const saved = JSON.parse(await readFile(join(dataDir, "pairing.json"), "utf8"));
  assert.equal(saved.attempts, 0);
  assert.deepEqual(await pairing.redeem(code, async () => {}), { ok: true, label: "Malformed" });
});

test("invalid persisted records fail closed", async (t) => {
  const base = {
    hash: "hash",
    salt: "salt",
    createdAt: "2026-10-25T12:00:00.000Z",
    expiresAt: "2026-10-25T12:10:00.000Z",
    attempts: 0,
    label: "Bad",
    state: "active",
  };
  const records = [
    { ...base, hash: 7 },
    { ...base, hash: "" },
    { ...base, salt: undefined },
    { ...base, attempts: -1 },
    { ...base, attempts: 1.5 },
    { ...base, expiresAt: "not a date" },
    { ...base, label: 7 },
    { ...base, state: "other" },
  ];
  for (const record of records) {
    const dataDir = await dir(t);
    await writePrivateJson(join(dataDir, "pairing.json"), record);
    const pairing = createPairing({ dataDir, secret: SECRET });
    await pairing.init();
    assert.deepEqual(await pairing.redeem("AAAA-AAAA", async () => {}), {
      ok: false,
      reason: "missing",
    });
  }
});

test("labels are capped by code point", async (t) => {
  const pairing = createPairing({ dataDir: await dir(t), secret: SECRET });
  await pairing.init();
  const label = "😀".repeat(70);
  const opened = await pairing.open(label);
  assert.equal(opened.label, "😀".repeat(64));
});
