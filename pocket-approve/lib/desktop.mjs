import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const APP_NAME = "Pocket Approve";
const REPLACES_ID = "0";
const ICON = "dialog-question";
const ACTIONS = "['once','Allow once','always','Allow always','reject','Deny']";
const HINTS = "{'urgency': <byte 2>}";
const TIMEOUT = "-1";
const DECISIONS = new Set(["once", "always", "reject"]);

const CALL = [
  "call",
  "--session",
  "--dest",
  "org.freedesktop.Notifications",
  "--object-path",
  "/org/freedesktop/Notifications",
];

const MONITOR = ["monitor", "--session", "--dest", "org.freedesktop.Notifications"];

export function buildNotifyArgs(request = {}) {
  return [
    ...CALL,
    "--method",
    "org.freedesktop.Notifications.Notify",
    "--",
    APP_NAME,
    REPLACES_ID,
    ICON,
    request.title ?? "",
    request.summary ?? "",
    ACTIONS,
    HINTS,
    TIMEOUT,
  ];
}

export function buildCloseArgs(id) {
  return [
    ...CALL,
    "--method",
    "org.freedesktop.Notifications.CloseNotification",
    String(id),
  ];
}

export function parseNotifyId(stdout) {
  const match = String(stdout ?? "").match(/\(\s*uint32\s+(\d+)\s*,\s*\)/);
  return match ? Number(match[1]) : null;
}

export function parseActionLine(line) {
  const text = String(line ?? "");
  if (text.includes("ActionInvoked")) {
    const match = text.match(/ActionInvoked\s*\(\s*uint32\s+(\d+)\s*,\s*'([^']*)'\s*\)/);
    return match ? { id: Number(match[1]), decision: match[2] } : null;
  }
  if (text.includes("NotificationClosed")) {
    const match = text.match(/NotificationClosed\s*\(\s*uint32\s+(\d+)\s*,\s*uint32\s+\d+\s*\)/);
    return match ? { id: Number(match[1]), closed: true } : null;
  }
  return null;
}

export function createDesktop({ spawnFn = spawn, log = console } = {}) {
  const pendingById = new Map();
  const idByRequest = new Map();
  const actionHandlers = new Set();
  const closedHandlers = new Set();
  let monitor = null;

  function logError(message, error) {
    try {
      if (log && typeof log.error === "function") {
        if (error === undefined) log.error(message);
        else log.error(message, error);
      }
    } catch {}
  }

  function emit(handlers, payload) {
    for (const handler of [...handlers]) {
      try {
        handler(payload);
      } catch (error) {
        logError("desktop: notification handler failed", error);
      }
    }
  }

  function settle(pending, decision) {
    pendingById.delete(pending.id);
    idByRequest.delete(pending.requestId);
    pending.resolve({ id: pending.id, decision });
  }

  function handleEvent(event) {
    const pending = pendingById.get(event.id);
    if (!pending) return;
    if (event.closed) {
      settle(pending, null);
      emit(closedHandlers, {
        id: pending.id,
        requestId: pending.requestId,
        request: pending.request,
      });
      return;
    }
    if (!DECISIONS.has(event.decision)) return;
    settle(pending, event.decision);
    emit(actionHandlers, {
      id: pending.id,
      requestId: pending.requestId,
      request: pending.request,
      decision: event.decision,
    });
  }

  function failAll() {
    for (const pending of [...pendingById.values()]) {
      pendingById.delete(pending.id);
      idByRequest.delete(pending.requestId);
      pending.resolve({ id: null, decision: null });
    }
  }

  function ensureMonitor() {
    if (monitor) return true;
    let child;
    try {
      child = spawnFn("gdbus", MONITOR);
    } catch (error) {
      logError("desktop: could not start the notification monitor", error);
      return false;
    }
    monitor = child;
    child.on("error", (error) => {
      logError("desktop: notification monitor failed", error);
      if (monitor === child) {
        monitor = null;
        failAll();
      }
    });
    child.on("close", (code) => {
      if (monitor !== child) return;
      monitor = null;
      logError(`desktop: notification monitor closed${code === null ? "" : ` with code ${code}`}`);
      failAll();
    });
    if (!child.stdout) {
      logError("desktop: notification monitor has no output");
      return false;
    }
    child.stdout.on("error", (error) => {
      logError("desktop: notification monitor output failed", error);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const event = parseActionLine(line);
      if (event) handleEvent(event);
    });
    return true;
  }

  async function notify(request = {}) {
    if (!ensureMonitor()) return { id: null, decision: null };
    let child;
    try {
      child = spawnFn("gdbus", buildNotifyArgs(request));
    } catch (error) {
      logError("desktop: could not run gdbus Notify", error);
      return { id: null, decision: null };
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout?.on("error", (error) => {
      logError("desktop: could not read gdbus Notify output", error);
    });
    child.stderr?.on("error", (error) => {
      logError("desktop: could not read gdbus Notify errors", error);
    });

    const result = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.once("error", (error) => finish({ code: null, error }));
      child.once("close", (code) => finish({ code }));
    });

    const id = parseNotifyId(stdout);
    if (result.error || result.code !== 0 || id === null) {
      const detail = result.error
        ? result.error.message
        : (stderr.trim() || `exit code ${result.code}`);
      logError(`desktop: gdbus Notify failed: ${detail}`);
      return { id: null, decision: null };
    }

    return new Promise((resolve) => {
      const pending = {
        id,
        requestId: request.id,
        request,
        resolve,
      };
      pendingById.set(id, pending);
      if (request.id !== undefined && request.id !== null) {
        idByRequest.set(request.id, id);
      }
    });
  }

  function close(requestOrNotificationId) {
    let id = idByRequest.get(requestOrNotificationId);
    let requestId = requestOrNotificationId;
    let pending = id === undefined ? undefined : pendingById.get(id);
    if (id === undefined) {
      pending = pendingById.get(requestOrNotificationId);
      if (!pending) return;
      id = pending.id;
      requestId = pending.requestId;
    }

    idByRequest.delete(requestId);
    if (pending) settle(pending, null);

    let child;
    try {
      child = spawnFn("gdbus", buildCloseArgs(id));
    } catch (error) {
      logError("desktop: could not run gdbus CloseNotification", error);
      return;
    }
    child.on?.("error", (error) => {
      logError("desktop: gdbus CloseNotification failed", error);
    });
    child.stderr?.on?.("data", (chunk) => {
      logError(`desktop: gdbus CloseNotification failed: ${String(chunk).trim()}`);
    });
  }

  function onAction(handler) {
    if (typeof handler !== "function") return () => {};
    actionHandlers.add(handler);
    return () => actionHandlers.delete(handler);
  }

  function onClosed(handler) {
    if (typeof handler !== "function") return () => {};
    closedHandlers.add(handler);
    return () => closedHandlers.delete(handler);
  }

  function stop() {
    const child = monitor;
    monitor = null;
    if (!child) return;
    try {
      child.kill();
    } catch (error) {
      logError("desktop: could not stop the notification monitor", error);
    }
    failAll();
  }

  return { notify, close, onAction, onClosed, stop };
}
