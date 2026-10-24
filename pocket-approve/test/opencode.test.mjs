import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createClient } from "../lib/opencode.mjs";
import { createOpenCodeSource } from "../lib/adapters/opencode.mjs";

const json = (res, body, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

test("list and reply hit the live-shaped endpoints", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/permission") {
      return json(res, [
        { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["touch x"], metadata: {} },
      ]);
    }
    if (req.method === "POST" && req.url === "/permission/per_1/reply") {
      assert.equal(
        req.headers.authorization,
        "Basic " + Buffer.from("opencode:pw").toString("base64"),
      );
      return json(res, true);
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const client = createClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    password: "pw",
  });
  assert.equal((await client.list())[0].id, "per_1");
  assert.equal(await client.reply("per_1", "once"), true);
});

test("client sends no auth header without a password", async (t) => {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    json(res, []);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const client = createClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  assert.deepEqual(await client.list(), []);
});

test("client throws an error carrying the response status", async (t) => {
  const server = http.createServer((_req, res) => json(res, { error: "nope" }, 502));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const client = createClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(client.list(), (error) => {
    assert.equal(error.status, 502);
    return true;
  });
});

test("adapter maps the live request shape and ignores title and time", async () => {
  const raw = {
    id: "per_2",
    sessionID: "ses_2",
    permission: "bash",
    patterns: ["rm -rf /tmp/x"],
    metadata: { command: "rm -rf /tmp/x" },
    title: "stale title",
    time: { created: 1 },
  };
  const calls = [];
  const source = createOpenCodeSource({
    list: async () => [raw],
    reply: async (id, decision) => {
      calls.push([id, decision]);
      return true;
    },
  });

  assert.deepEqual(await source.list(), [
    {
      id: "per_2",
      sessionID: "ses_2",
      permission: "bash",
      patterns: ["rm -rf /tmp/x"],
      metadata: { command: "rm -rf /tmp/x" },
      title: "Bash: rm -rf /tmp/x",
      summary: "rm -rf /tmp/x",
    },
  ]);
  assert.equal(await source.reply("per_2", "always"), true);
  assert.deepEqual(calls, [["per_2", "always"]]);
});

test("adapter tolerates missing patterns and metadata", async () => {
  const source = createOpenCodeSource({
    list: async () => [{ id: "per_3", sessionID: "ses_3", permission: "edit" }],
    reply: async () => true,
  });

  assert.deepEqual(await source.list(), [
    {
      id: "per_3",
      sessionID: "ses_3",
      permission: "edit",
      patterns: [],
      metadata: {},
      title: "Edit",
      summary: "(no details)",
    },
  ]);
});
