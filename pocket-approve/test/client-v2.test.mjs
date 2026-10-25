import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const appPath = fileURLToPath(new URL("../public/app.js", import.meta.url));

test("client is syntactically valid and has no unsafe token storage", async () => {
  const source = await readFile(appPath, "utf8");
  await run(process.execPath, ["--check", appPath]);
  assert.equal(source.includes("localStorage"), false);
  assert.equal(source.includes('params.get("token")'), true);
  assert.equal(source.includes('createObjectStore("session")'), true);
  assert.equal(source.includes("/api/pair"), true);
  assert.equal(source.includes("/api/pending"), true);
  assert.equal(source.includes("applicationServerKey"), true);
  assert.equal(source.includes("visibilitychange"), true);
  assert.equal(source.includes("navigator.standalone"), true);
  assert.equal(source.includes("(display-mode: standalone)"), true);
  assert.equal(source.includes("Add Pocket Approve to your Home Screen first."), true);
  assert.equal(source.includes("registration.waiting"), true);
  assert.equal(source.includes("SKIP_WAITING"), true);
  assert.equal(source.includes("Already answered or expired."), true);
  assert.equal(source.includes("This device was disconnected. Pair again."), true);
});

test("client keeps the shell visibility contract", async () => {
  const source = await readFile(appPath, "utf8");
  assert.equal(source.includes("settingsButton.hidden"), true);
  assert.equal(source.includes("notice.hidden"), true);
  assert.equal(source.includes("pairError.hidden"), true);
  assert.equal(source.includes("deviceSummary"), true);
});

test("client renders pending requests as list items with the request card classes", async () => {
  const source = await readFile(appPath, "utf8");
  assert.equal(source.includes('createElement("li")'), true);
  assert.equal(source.includes('"request card"'), true);
});
