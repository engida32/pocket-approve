import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const workerPath = fileURLToPath(new URL("../public/sw.js", import.meta.url));

test("service worker parses and never approves from the notification shade", async () => {
  const source = await readFile(workerPath, "utf8");
  await run(process.execPath, ["--check", workerPath]);

  assert.match(source, /action:\s*"reject",\s*title:\s*"Deny"/);
  assert.match(source, /action:\s*"review",\s*title:\s*"Review"/);
  assert.doesNotMatch(source, /action:\s*"(?:once|always)"/);
  assert.doesNotMatch(source, /["'](?:once|always)["']/);

  const installStart = source.indexOf('self.addEventListener("install"');
  const activateStart = source.indexOf('self.addEventListener("activate"');
  assert.ok(installStart >= 0, "install listener exists");
  assert.ok(activateStart > installStart, "activate follows install");
  const installBlock = source.slice(installStart, activateStart);
  assert.doesNotMatch(installBlock, /skipWaiting/);

  assert.match(source, /db\.deleteObjectStore\("auth"\)/);
  assert.match(source, /onblocked/);
  assert.match(source, /pushsubscriptionchange/);
  assert.match(source, /\/\?error=\$\{/);
  assert.match(source, /failPath\("auth"\)/);
  assert.match(source, /failPath\("answered"\)/);
  assert.match(source, /failPath\("offline"\)/);
  assert.match(source, /request=/);
  assert.match(source, /kind === "request" \? requestUrl\(payload\.id\) : "\/"/);
  assert.match(source, /\/pair\?request=/);
});

test("service worker preserves the storage, endpoint, and decision contract", async () => {
  const source = await readFile(workerPath, "utf8");

  assert.match(source, /const DB_VERSION = 2;/);
  assert.match(source, /const SESSION_STORE = "session";/);
  assert.match(source, /const SESSION_KEY = "current";/);

  assert.match(source, /"\/api\/reply"/);
  assert.match(source, /"\/api\/subscribe"/);
  assert.match(source, /"\/api\/vapid-public-key"/);

  assert.match(source, /reply\(session, data\.id, "reject"\)/);

  assert.match(source, /result\.status === 401/);
  assert.match(source, /result\.status === 404 \|\| result\.status === 409/);
  assert.match(source, /result\.status === 502 \|\| result\.status === 0/);

  assert.doesNotMatch(source, /badge:/);
});

test("push parse failure falls back to a default notification", async () => {
  const source = await readFile(workerPath, "utf8");
  const pushStart = source.indexOf('self.addEventListener("push"');
  const clickStart = source.indexOf('self.addEventListener("notificationclick"');
  assert.ok(pushStart >= 0, "push listener exists");
  assert.ok(clickStart > pushStart, "notificationclick follows push");
  const pushBlock = source.slice(pushStart, clickStart);

  assert.match(pushBlock, /catch\s*\{\s*payload = \{\};/);
  assert.doesNotMatch(pushBlock, /catch\s*\{\s*return;/);
  assert.match(pushBlock, /showNotification\(String\(payload\.title \|\| "Pocket Approve"\)\.slice\(0, 64\), options\)/);
  assert.match(pushBlock, /String\(payload\.summary \|\| "Open Pocket Approve to review\."\)\.slice\(0, 180\)/);
  assert.match(pushBlock, /payload\.sessionID/);
  assert.match(pushBlock, /requireInteraction: kind === "request"/);
});
