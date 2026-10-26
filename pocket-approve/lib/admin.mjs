import { chmod } from "node:fs/promises";
import { createServer } from "node:net";

function line(value) {
  return JSON.stringify(value) + "\n";
}

export function createAdmin({
  socketPath,
  config,
  devices,
  pairing,
  push,
  fleet,
  audit = null,
  log = console,
} = {}) {
  if (!socketPath || !config || !devices || !pairing || !push || !fleet) {
    throw new TypeError("socketPath, config, devices, pairing, push, and fleet are required");
  }
  let server = null;

  async function handle(message) {
    if (!message || typeof message !== "object") return { ok: false, error: "invalid_request" };
    if (message.command === "pair") {
      const label = typeof message.label === "string" && message.label.trim() ? message.label.trim() : "Device";
      const opened = await pairing.open(label);
      await audit?.append("pair", { result: "opened" });
      return {
        ok: true,
        code: opened.code,
        expiresAt: opened.expiresAt,
        url: `${config.publicOrigin}/pair#code=${opened.code}`,
      };
    }
    if (message.command === "devices") {
      return {
        ok: true,
        devices: devices.list().map((device) => ({
          id: device.id,
          name: device.name,
          prefix: device.tokenPrefix ?? null,
          createdAt: device.createdAt,
          lastSeenAt: device.lastSeenAt,
          revokedAt: device.revokedAt,
        })),
      };
    }
    if (message.command === "revoke") {
      if (typeof message.id !== "string" || !message.id.startsWith("dev_")) {
        return { ok: false, error: "invalid_device_id" };
      }
      const changed = await devices.revoke(message.id);
      if (!changed) return { ok: false, error: "device_not_found" };
      const pruned = await push.removeByDevice(message.id);
      await audit?.append("revoke", { deviceId: message.id, result: `subscriptions:${pruned}` });
      return { ok: true, id: message.id, subscriptionsRemoved: pruned };
    }
    if (message.command === "doctor") {
      const health = fleet.servers();
      const checks = [
        { name: "mode", ok: config.mode === "proxy" || config.mode === "lan", detail: config.mode },
        { name: "origin", ok: config.mode === "lan" || /^https:\/\//.test(config.publicOrigin ?? ""), detail: config.publicOrigin ?? "lan" },
        { name: "servers", ok: Array.isArray(config.servers) && config.servers.length > 0, detail: String(config.servers?.length ?? 0) },
        { name: "vapid", ok: Boolean(config.vapid?.publicKey), detail: config.vapid?.publicKey ? "present" : "missing" },
        { name: "pairingSecret", ok: typeof config.pairingSecret === "string" && config.pairingSecret.length >= 20, detail: config.pairingSecret ? "present" : "missing" },
        { name: "devices", ok: true, detail: String(devices.activeCount()) },
        { name: "fleet", ok: health.some((row) => row.ok), detail: health.map((row) => `${row.id}:${row.ok ? "ok" : "down"}`).join(",") },
      ];
      return { ok: true, checks, servers: health.map((row) => ({ id: row.id, label: row.label, ok: row.ok, pending: row.pending ?? null })) };
    }
    return { ok: false, error: "unknown_command" };
  }

  async function start() {
    if (server) return;
    const created = createServer({ allowHalfOpen: true }, (socket) => {
      let data = "";
      let pending = false;
      socket.setEncoding("utf8");
      socket.on("error", () => {
        log?.error?.("admin: socket error");
      });
      socket.on("end", () => {
        if (!pending) socket.end();
      });
      socket.on("data", (chunk) => {
        if (pending) return;
        data += chunk;
        if (data.length > 64 * 1024) {
          socket.end(line({ ok: false, error: "request_too_large" }));
          return;
        }
        const newline = data.indexOf("\n");
        if (newline === -1) return;
        const raw = data.slice(0, newline);
        data = data.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          socket.end(line({ ok: false, error: "invalid_json" }));
          return;
        }
        pending = true;
        handle(message)
          .then((result) => socket.end(line(result)))
          .catch((error) => {
            log?.error?.("admin: command failed", error);
            socket.end(line({ ok: false, error: "command_failed" }));
          });
      });
    });
    try {
      await new Promise((resolve, reject) => {
        created.once("error", reject);
        created.listen(socketPath, () => {
          created.off("error", reject);
          resolve();
        });
      });
      await chmod(socketPath, 0o600);
    } catch (error) {
      await new Promise((resolve) => created.close(() => resolve()));
      throw error;
    }
    server = created;
  }

  async function stop() {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }

  return { start, stop, handle };
}
