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

import { buildRequestMessage, buildTestMessage, fitMessage } from "../lib/ntfy.mjs";

const item = {
  id: "alpha:req_1",
  serverId: "alpha",
  serverLabel: "Alpha",
  sessionID: "ses_1",
  permission: "bash",
  patterns: ["rm -rf /tmp/x", "git push"],
  always: ["Bash(rm:*)"],
  tool: "bash",
  metadata: {
    command: "rm -rf /tmp/x",
    path: "/home/user/project",
    description: "Remove a temporary directory",
  },
  title: "Bash: rm -rf /tmp/x",
  summary: "Remove a temporary directory",
  firstSeen: "2026-10-26T10:00:00.000Z",
};

test("buildRequestMessage creates three signed HTTP actions", () => {
  const settings = createSettings();
  const message = buildRequestMessage(item, settings);
  assert.equal(message.topic, settings.outTopic);
  assert.match(message.title, /^\[Alpha\] /);
  assert.ok(Buffer.byteLength(message.title) <= 64);
  assert.match(message.message, /Command: rm -rf \/tmp\/x/);
  assert.match(message.message, /Path: \/home\/user\/project/);
  assert.match(message.message, /Patterns: rm -rf \/tmp\/x, git push/);
  assert.equal(message.priority, 4);
  assert.deepEqual(message.tags, ["warning"]);
  assert.equal(message.actions.length, 3);
  assert.deepEqual(message.actions.map((action) => action.label), [
    "Allow once",
    "Always allow",
    "Deny",
  ]);
  const body = JSON.parse(message.actions[0].body);
  assert.equal(body.id, item.id);
  assert.equal(body.decision, "once");
  assert.equal(verifyReply(settings.secret, body.id, body.decision, body.sig), true);
  assert.equal(message.actions[0].url, `${settings.baseUrl}/${settings.replyTopic}`);
  assert.equal(message.actions[0].method, "POST");
  assert.equal(message.actions[0].clear, true);
});

test("buildRequestMessage can omit Always allow", () => {
  const message = buildRequestMessage(item, createSettings(), { allowAlways: false });
  assert.deepEqual(message.actions.map((action) => action.label), ["Allow once", "Deny"]);
});

test("buildTestMessage has one test action and no real request id", () => {
  const settings = createSettings();
  const message = buildTestMessage(settings, "test:123");
  assert.equal(message.actions.length, 1);
  assert.equal(message.actions[0].label, "Send test reply");
  assert.deepEqual(JSON.parse(message.actions[0].body), {
    id: "test:123",
    decision: "once",
    sig: signReply(settings.secret, "test:123", "once"),
  });
});

test("fitMessage keeps the summary and actions under 4000 bytes", () => {
  const settings = createSettings();
  const huge = {
    ...item,
    metadata: { command: "x".repeat(12000), path: "y".repeat(4000) },
  };
  const message = buildRequestMessage(huge, settings);
  assert.ok(Buffer.byteLength(JSON.stringify(message)) < 4000);
  assert.ok(message.message.startsWith(item.summary));
  assert.equal(message.actions.length, 3);
});

test("fitMessage does not mutate its input", () => {
  const input = buildRequestMessage(item, createSettings());
  const before = JSON.stringify(input);
  fitMessage(input, 300);
  assert.equal(JSON.stringify(input), before);
});

test("fitMessage truncates a long detail line instead of dropping it", () => {
  const long = {
    ...item,
    metadata: { command: "x".repeat(6000) },
    patterns: [],
  };
  const message = buildRequestMessage(long, createSettings());
  const command = message.message
    .split("\n")
    .find((line) => line.startsWith("Command: "));
  assert.ok(command, "Command detail line should survive");
  assert.ok(command.endsWith("..."));
  assert.ok(command.length < 6000);
  assert.ok(Buffer.byteLength(JSON.stringify(message)) < 4000);
});

test("buildRequestMessage caps non-ASCII titles at 64 bytes without splitting characters", () => {
  const nonAscii = { ...item, serverLabel: "日本", title: "🚀".repeat(40) };
  const message = buildRequestMessage(nonAscii, createSettings());
  assert.ok(Buffer.byteLength(message.title) <= 64);
  assert.equal(message.title, Buffer.from(message.title, "utf8").toString("utf8"));
});
