#!/usr/bin/env node
import { connect } from "node:net";
import { join } from "node:path";
import { DATA_DIR } from "../lib/config.mjs";

const USAGE = `usage: pocket-approve ask --title <text> [--body <text>] [--source <name>] [--timeout <seconds>]

Blocks until the approval is answered on the paired phone or desktop.
Exit codes: 0 approved (once/always), 1 rejected, 2 usage or transport error, 3 timed out.`;

const [command, ...args] = process.argv.slice(2);

function option(name) {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1] ?? null;
}

function finish(code, message) {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(`${message}\n`);
  process.exit(code);
}

if (!command || command === "--help" || command === "-h" || command === "help") {
  process.stdout.write(`${USAGE}\n`);
  process.exit(command ? 0 : 2);
}

if (command !== "ask") finish(2, `Unknown command: ${command}\n\n${USAGE}`);

const title = option("--title");
if (!title || !title.trim()) finish(2, `Missing --title\n\n${USAGE}`);

const seconds = Number(option("--timeout"));
const request = {
  command: "ask",
  title,
  body: option("--body") ?? "",
  source: option("--source") ?? "cli",
};
if (Number.isFinite(seconds) && seconds > 0) request.timeoutMs = Math.round(seconds * 1000);

const socketPath = process.env.POCKET_APPROVE_ADMIN ?? join(DATA_DIR, "admin.sock");
const socket = connect(socketPath);
let data = "";

socket.setEncoding("utf8");
socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
socket.on("data", (chunk) => { data += chunk; });
socket.on("error", (error) => {
  if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
    finish(2, "Pocket Approve is not running. Start it with: npm start");
  }
  finish(2, `Cannot reach Pocket Approve: ${error.message}`);
});
socket.on("end", () => {
  let result;
  try {
    result = JSON.parse(data);
  } catch {
    finish(2, "Pocket Approve returned an unreadable answer.");
  }
  if (!result.ok) {
    if (result.error === "timed_out") finish(3, "No answer before the timeout.");
    finish(2, `Request failed: ${result.error}`);
  }
  if (result.decision === "reject") finish(1, `Rejected (${result.id})`);
  finish(0, `Approved: ${result.decision} (${result.id})`);
});
