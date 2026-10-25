import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { toNodeHandler } from "../lib/node-http.mjs";

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { server, port };
}

test("the node bridge converts a fetch handler into a request listener", async (t) => {
  const server = createServer(toNodeHandler(async (request) => {
    const url = new URL(request.url);
    return new Response(JSON.stringify({ path: url.pathname, method: request.method }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/hello`, { method: "POST", body: "x" });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { path: "/hello", method: "POST" });
  const head = await fetch(`http://127.0.0.1:${port}/hello`, { method: "HEAD" });
  assert.equal(head.status, 201);
  assert.equal(await head.text(), "");
});

test("the node bridge rejects a request body over 64 KiB with 413", async (t) => {
  const { server, port } = await listen(toNodeHandler(async () => new Response("ok")));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${port}/upload`, {
    method: "POST",
    body: "x".repeat(64 * 1024 + 1),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "body_too_large" });
});

test("the node bridge rejects a chunked body over 64 KiB with 413", async (t) => {
  const { server, port } = await listen(toNodeHandler(async () => new Response("ok")));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const payload = new TextEncoder().encode("x".repeat(64 * 1024 + 1));
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
  const response = await fetch(`http://127.0.0.1:${port}/upload`, {
    method: "POST",
    body,
    duplex: "half",
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "body_too_large" });
});

test("the node bridge suppresses bodies for 204 and 304 responses", async (t) => {
  const { server, port } = await listen(toNodeHandler(async (request) => {
    const url = new URL(request.url);
    const status = url.pathname === "/no-content" ? 204 : 304;
    return new Response(null, { status, headers: { etag: "\"abc\"" } });
  }));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const noContent = await fetch(`http://127.0.0.1:${port}/no-content`);
  assert.equal(noContent.status, 204);
  assert.equal(await noContent.text(), "");
  const notModified = await fetch(`http://127.0.0.1:${port}/not-modified`);
  assert.equal(notModified.status, 304);
  assert.equal(await notModified.text(), "");
});

test("the node bridge preserves multiple set-cookie headers", async (t) => {
  const { server, port } = await listen(toNodeHandler(async () => {
    const headers = new Headers();
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");
    return new Response("ok", { status: 200, headers });
  }));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${port}/cookies`);
  assert.deepEqual(response.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
});

test("the node bridge does not leak internal error details", async (t) => {
  const { server, port } = await listen(toNodeHandler(async () => {
    throw new Error("secret path /etc/shadow");
  }));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${port}/boom`);
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: "internal_error" });
  assert.doesNotMatch(text, /shadow|secret/i);
});

test("the node bridge logs one fixed message without leaking error details", async (t) => {
  const calls = [];
  const log = {
    error(...args) {
      calls.push(args);
    },
  };
  const { server, port } = await listen(toNodeHandler(async () => {
    throw new Error("secret path /etc/shadow");
  }, { log }));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${port}/boom`);
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: "internal_error" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["node-http: request failed"]);
  assert.doesNotMatch(JSON.stringify(calls), /shadow|secret/i);
});
