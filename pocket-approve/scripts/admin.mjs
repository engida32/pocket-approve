#!/usr/bin/env node
import { connect } from "node:net";
import { join } from "node:path";
import { DATA_DIR } from "../lib/config.mjs";

const [command = "doctor", ...args] = process.argv.slice(2);
const socketPath = process.env.POCKET_APPROVE_ADMIN ?? join(DATA_DIR, "admin.sock");

function option(name) {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1] ?? null;
}

let request;
if (command === "pair") request = { command: "pair", label: option("--label") ?? "Device" };
else if (command === "devices") request = { command: "devices" };
else if (command === "revoke") request = { command: "revoke", id: args[0] ?? null };
else if (command === "doctor") request = { command: "doctor" };
else {
  console.error(`Unknown command: ${command}`);
  process.exit(2);
}

const socket = connect(socketPath);
let data = "";
socket.setEncoding("utf8");
socket.on("connect", () => socket.end(JSON.stringify(request) + "\n"));
socket.on("data", (chunk) => { data += chunk; });
socket.on("error", (error) => {
  if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
    console.error("Pocket Approve is not running. Start it with: npm start");
  } else {
    console.error(error.message);
  }
  process.exit(1);
});
socket.on("end", () => {
  let result;
  try {
    result = JSON.parse(data);
  } catch {
    console.error("The sidecar returned an unreadable answer.");
    process.exit(1);
  }
  if (!result.ok) {
    console.error(`Failed: ${result.error}`);
    process.exit(1);
  }
  if (command === "pair") {
    console.log(`Pair code: ${result.code}`);
    console.log(`Open:      ${result.url}`);
    console.log(`Expires:   ${result.expiresAt}`);
  } else if (command === "devices") {
    if (result.devices.length === 0) console.log("No paired devices.");
    for (const device of result.devices) {
      const state = device.revokedAt ? "revoked" : "active";
      console.log(`${device.id}  ${state}  ${device.name}  last seen ${device.lastSeenAt ?? "never"}`);
    }
  } else if (command === "revoke") {
    console.log(`Revoked ${result.id}. Removed ${result.subscriptionsRemoved} subscription(s).`);
  } else {
    for (const check of result.checks) {
      console.log(`${check.ok ? "ok" : "FAIL"}  ${check.name}  ${check.detail}`);
    }
    console.log("");
    for (const server of result.servers) {
      console.log(`${server.id}  ${server.ok ? "up" : "down"}  ${server.label}  pending ${server.pending ?? "?"}`);
    }
  }
});
