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
  assert.equal(source.includes("localStorage.setItem"), false);
  assert.equal(source.includes("localStorage.getItem"), false);
  assert.equal(source.includes("localStorage.removeItem"), true);
  assert.equal(source.includes('deleteObjectStore("auth")'), true);
  assert.equal(source.includes('params.get("token")'), true);
  assert.equal(source.includes('createObjectStore("session")'), true);
  assert.equal(source.includes("/api/pair"), true);
  assert.equal(source.includes("/api/pending"), true);
  assert.equal(source.includes("/api/revoke"), true);
  assert.equal(source.includes("/api/subscribe"), true);
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

test("renderSession leaves pending loads to its caller", async () => {
  const source = await readFile(appPath, "utf8");
  const start = source.indexOf("function renderSession()");
  const end = source.indexOf("function pairFromHash()", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.equal(source.slice(start, end).includes("loadPending"), false);
});

test("pairing links prefill the device name", async () => {
  const source = await readFile(appPath, "utf8");
  const pairStart = source.indexOf("function pairFromHash()");
  const pairEnd = source.indexOf("async function pair(", pairStart);
  assert.notEqual(pairStart, -1);
  assert.notEqual(pairEnd, -1);
  const pairSource = source.slice(pairStart, pairEnd);
  assert.match(pairSource, /params\.get\("label"\)/);
  assert.match(pairSource, /sessionStorage\.setItem\("pending-device-name",/);

  const renderStart = source.indexOf("function renderSession()");
  const renderEnd = source.indexOf("function pairFromHash()", renderStart);
  assert.notEqual(renderStart, -1);
  assert.notEqual(renderEnd, -1);
  const renderSource = source.slice(renderStart, renderEnd);
  assert.match(renderSource, /sessionStorage\.getItem\("pending-device-name"\)/);
  assert.match(renderSource, /els\.deviceName\.value =/);
  assert.match(renderSource, /sessionStorage\.removeItem\("pending-device-name"\)/);
});

test("client polls the visible screen every five seconds", async () => {
  const source = await readFile(appPath, "utf8");
  assert.match(source, /const POLL_MS = 5_000;/);
  assert.match(source, /const ERROR_POLL_MS = 20_000;/);
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
  assert.equal(source.includes("request-meta"), true);
  assert.equal(source.includes("request.sessionID"), true);
});

test("styles cover the shell, dialogs, and request card surfaces", async () => {
  const css = await readFile(fileURLToPath(new URL("../public/style.css", import.meta.url)), "utf8");
  for (const selector of [
    "[hidden]",
    ".site-header",
    ".panel",
    ".banner",
    ".inbox-heading",
    ".count",
    ".server-chip",
    ".request-meta",
    ".primary",
    ".danger",
    ".quiet",
    ".settings-actions",
    ".muted",
    ".error",
    "dialog",
  ]) {
    assert.equal(css.includes(selector), true, selector);
  }
});
