import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSettings,
  loadSettings,
  normalizeSettings,
  ntfyLink,
  parseReply,
  rotateSettings,
  saveSettings,
  signReply,
  verifyReply,
} from "../lib/ntfy.mjs";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "pa-ntfy-"));
}

test("createSettings makes distinct random topics and a 43 character secret", () => {
  const settings = createSettings(() => new Date("2026-10-26T10:00:00.000Z"));
  assert.equal(settings.version, 1);
  assert.equal(settings.baseUrl, "https://ntfy.sh");
  assert.match(settings.outTopic, /^[A-Za-z0-9_-]{43}$/);
  assert.match(settings.replyTopic, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(settings.outTopic, settings.replyTopic);
  assert.match(settings.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(settings.createdAt, "2026-10-26T10:00:00.000Z");
  assert.equal(settings.lastEventId, null);
  assert.equal(settings.lastEventAt, null);
});

test("normalizeSettings rejects unsafe or ambiguous values", () => {
  const base = createSettings();
  assert.throws(() => normalizeSettings({ ...base, baseUrl: "http://ntfy.sh" }), /ntfy baseUrl/);
  assert.throws(() => normalizeSettings({ ...base, outTopic: "bad topic" }), /outTopic/);
  assert.throws(() => normalizeSettings({ ...base, outTopic: base.replyTopic }), /different/);
  assert.throws(() => normalizeSettings({ ...base, secret: "short" }), /secret/);
  assert.throws(() => normalizeSettings({ ...base, lastEventAt: "yesterday" }), /lastEventAt/);
});

test("saveSettings writes 0600 and loadSettings round trips", async () => {
  const dir = await tempDir();
  const settings = createSettings();
  const saved = await saveSettings(dir, settings);
  assert.deepEqual(saved, normalizeSettings(settings));
  const mode = (await stat(join(dir, "ntfy.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.match(await readFile(join(dir, "ntfy.json"), "utf8"), /"baseUrl": "https:\/\/ntfy\.sh"/);
  assert.deepEqual(await loadSettings(dir), saved);
});

test("loadSettings returns null when the file does not exist", async () => {
  assert.equal(await loadSettings(await tempDir()), null);
});

test("rotateSettings replaces topics and secret and clears the cursor", () => {
  const old = {
    ...createSettings(),
    lastEventId: "evt_1",
    lastEventAt: "2026-10-26T10:05:00.000Z",
  };
  const next = rotateSettings(old, () => new Date("2026-10-26T11:00:00.000Z"));
  assert.notEqual(next.outTopic, old.outTopic);
  assert.notEqual(next.replyTopic, old.replyTopic);
  assert.notEqual(next.secret, old.secret);
  assert.equal(next.lastEventId, null);
  assert.equal(next.lastEventAt, null);
  assert.equal(next.baseUrl, old.baseUrl);
});

test("ntfyLink encodes the display name and includes the outbound topic", () => {
  const settings = { ...createSettings(), outTopic: "out_topic-1" };
  assert.equal(
    ntfyLink(settings),
    "ntfy://ntfy.sh/out_topic-1?display=Pocket%20Approve",
  );
  assert.equal(
    ntfyLink(settings, "My Phone"),
    "ntfy://ntfy.sh/out_topic-1?display=My%20Phone",
  );
});

test("reply signatures verify only matching id, decision, and secret", () => {
  const secret = "a".repeat(43);
  const sig = signReply(secret, "alpha:req_1", "once");
  assert.equal(verifyReply(secret, "alpha:req_1", "once", sig), true);
  assert.equal(verifyReply(secret, "alpha:req_1", "reject", sig), false);
  assert.equal(verifyReply(secret, "alpha:req_2", "once", sig), false);
  assert.equal(verifyReply("b".repeat(43), "alpha:req_1", "once", sig), false);
  assert.equal(verifyReply(secret, "alpha:req_1", "once", ""), false);
});

test("parseReply validates JSON, decision, and signature", () => {
  const settings = createSettings();
  const body = JSON.stringify({
    id: "alpha:req_1",
    decision: "reject",
    sig: signReply(settings.secret, "alpha:req_1", "reject"),
  });
  assert.deepEqual(parseReply(settings, body), { id: "alpha:req_1", decision: "reject" });
  assert.equal(parseReply(settings, "not json"), null);
  assert.equal(parseReply(settings, JSON.stringify({ id: "alpha:req_1", decision: "maybe", sig: "x" })), null);
  assert.equal(parseReply(settings, JSON.stringify({ id: "alpha:req_1", decision: "once", sig: "x" })), null);
});
