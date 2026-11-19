import { randomUUID } from "node:crypto";

const DECISIONS = new Set(["once", "always", "reject"]);
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TITLE = 160;
const MAX_SUMMARY = 400;
const MAX_SOURCE = 32;

function failure(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function createGenericSource({ now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const waiting = new Map();

  function list() {
    return [...waiting.values()].map((entry) => entry.raw);
  }

  function ask({ title, body = "", source = "cli", timeoutMs: perRequest } = {}) {
    const cleanTitle = typeof title === "string" ? title.trim() : "";
    if (!cleanTitle) throw failure("title_required", 400);
    const cleanSource = typeof source === "string" && source.trim() ? source.trim().slice(0, MAX_SOURCE) : "cli";
    const summary = typeof body === "string" ? body.trim().slice(0, MAX_SUMMARY) : "";
    const id = `ask_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const budget = Number.isFinite(perRequest) && perRequest > 0 ? perRequest : timeoutMs;
    const raw = {
      id,
      sessionID: null,
      permission: "ask",
      patterns: [],
      always: [],
      tool: cleanSource,
      metadata: { adapter: "generic", source: cleanSource, askedAt: new Date(now()).toISOString() },
      title: cleanTitle.slice(0, MAX_TITLE),
      summary,
    };
    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve({ decision: null, timedOut: true });
      }, budget);
      timer.unref?.();
      waiting.set(id, { raw, resolve, timer });
    });
    return { id, promise };
  }

  function reply(rawId, decision) {
    if (!DECISIONS.has(decision)) throw failure("bad_decision", 400);
    const entry = waiting.get(rawId);
    if (!entry) throw failure("not_found", 404);
    waiting.delete(rawId);
    clearTimeout(entry.timer);
    entry.resolve({ decision, timedOut: false });
    return { ok: true, id: rawId, decision };
  }

  return { ask, list, reply, size: () => waiting.size };
}
