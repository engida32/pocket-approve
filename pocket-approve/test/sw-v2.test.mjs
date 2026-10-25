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
