import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const read = (name) => readFile(join(root, name), "utf8");

function pngSize(buffer) {
  assert.equal(buffer.subarray(1, 4).toString(), "PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test("manifest declares a stable id, standalone display, and installable icons", async () => {
  const manifest = JSON.parse(await read("public/manifest.webmanifest"));
  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#111111");
  assert.equal(manifest.background_color, "#f5f5f2");
  const sizes = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`);
  assert.ok(sizes.includes("192x192:any"));
  assert.ok(sizes.includes("512x512:any"));
  assert.ok(sizes.includes("512x512:maskable"));
});

test("PNG icons have the declared dimensions", async () => {
  const expected = [
    ["public/icon-192.png", 192],
    ["public/icon-512.png", 512],
    ["public/icon-maskable-512.png", 512],
    ["public/apple-touch-icon.png", 180],
  ];
  for (const [name, size] of expected) {
    const buffer = await readFile(join(root, name));
    const actual = pngSize(buffer);
    assert.deepEqual(actual, { width: size, height: size }, name);
  }
});

test("shell has pairing, install, inbox, and settings surfaces without inline script", async () => {
  const html = await read("public/index.html");
  for (const id of [
    "install-gate", "pair-section", "pair-form", "pair-code", "pair-error",
    "app-section", "settings-dialog", "enable-notifications", "send-test",
    "pending", "empty", "offline-banner", "pending-count", "update-banner", "update-button",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)/i);
  assert.doesNotMatch(html, /onclick=/i);
});

test("the shell loads no third-party origins", async () => {
  const html = await read("public/index.html");
  assert.doesNotMatch(html, /https?:\/\//i);
});
