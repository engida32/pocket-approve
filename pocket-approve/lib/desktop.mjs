import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const APP_NAME = "Pocket Approve";
const REPLACES_ID = "0";
const ICON = "";
const ACTIONS = "['once', 'Allow once', 'reject', 'Deny', 'always', 'Allow always']";
const NO_ACTIONS = "[]";
const HINTS = "{'urgency': <byte 2>}";
const TIMEOUT = "0";
const DECISIONS = new Set(["once", "always", "reject"]);

const MARKUP_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const GVARIANT_ESCAPES = new Map([
  ["\\", "\\\\"],
  ['"', '\\"'],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
  ["\b", "\\b"],
  ["\f", "\\f"],
  ["\v", "\\v"],
  ["\x07", "\\a"],
]);

const CALL = [
  "call",
  "--session",
  "--dest",
  "org.freedesktop.Notifications",
  "--object-path",
  "/org/freedesktop/Notifications",
];

const MONITOR_MATCH = "type='signal',interface='org.freedesktop.Notifications'";
const NOTIFICATION_PATH = "/org/freedesktop/Notifications";
const NOTIFICATION_INTERFACE = "org.freedesktop.Notifications";

function escapeMarkup(value) {
  return String(value ?? "").replace(/[&<>]/g, (char) => MARKUP_ESCAPES[char]);
}

export function gvariantString(value) {
  let out = '"';
  for (const char of String(value ?? "")) {
    const escape = GVARIANT_ESCAPES.get(char);
    if (escape) {
      out += escape;
      continue;
    }
    const code = char.codePointAt(0);
    if (code === 0) {
      out += "\uFFFD";
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += char;
    }
  }
  return `${out}"`;
}

export function buildNotifyArgs(request = {}) {
  return [
    ...CALL,
    "--method",
    "org.freedesktop.Notifications.Notify",
    "--",
    APP_NAME,
    REPLACES_ID,
    ICON,
    gvariantString(request.title ?? ""),
    gvariantString(escapeMarkup(request.summary ?? "")),
    request.actions === false ? NO_ACTIONS : ACTIONS,
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

function unescapeSignalString(value) {
  return String(value ?? "").replace(/\\(x[0-9a-fA-F]{2}|[0-7]{1,3}|[\s\S])/g, (match, code) => {
    if (/^x[0-9a-fA-F]{2}$/.test(code)) return String.fromCharCode(Number.parseInt(code.slice(1), 16));
    if (/^[0-7]{1,3}$/.test(code)) return String.fromCharCode(Number.parseInt(code, 8));
    const simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", a: "\x07" };
    return simple[code] ?? code;
  });
}

export function createSignalParser(onEvent) {
  let current = null;
  const emit = typeof onEvent === "function" ? onEvent : () => {};
  return function feed(line) {
    const text = String(line ?? "");
    const header = text.match(/^signal\s+time=.*\bpath=([^;]+); interface=([^;]+); member=([A-Za-z0-9_]+)/);
    if (header) {
      const kind = header[3] === "ActionInvoked" ? "action" : header[3] === "NotificationClosed" ? "closed" : null;
      current = kind && header[1] === NOTIFICATION_PATH && header[2] === NOTIFICATION_INTERFACE
        ? { kind, id: null, decision: null }
        : null;
      return;
    }
    if (!current) return;
    const integer = text.match(/^\s+u?int32\s+(\d+)\s*$/);
    if (integer) {
      if (current.id === null) current.id = Number(integer[1]);
      if (current.kind === "closed" && current.id !== null) {
        const event = { id: current.id, closed: true };
        current = null;
        emit(event);
      }
      return;
    }
    const string = text.match(/^\s+string\s+"((?:\\.|[^"\\])*)"\s*$/);
    if (string && current.kind === "action" && current.id !== null) {
      const event = { id: current.id, decision: unescapeSignalString(string[1]) };
      current = null;
      emit(event);
      return;
    }
    if (/^\S/.test(text)) current = null;
  };
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
      child = spawnFn("dbus-monitor", ["--session", MONITOR_MATCH]);
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
    child.stderr?.on("error", (error) => {
      logError("desktop: notification monitor error output failed", error);
    });
    child.stderr?.resume?.();
    const feed = createSignalParser(handleEvent);
    createInterface({ input: child.stdout }).on("line", feed);
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
