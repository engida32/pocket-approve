export const DECISIONS = Object.freeze(["once", "always", "reject"]);
const ALLOWED = new Set(DECISIONS);

function validId(id) {
  return typeof id === "string" && id.length > 0;
}

export function createState({ source, desktop = null } = {}) {
  if (!source || typeof source.reply !== "function") {
    throw new TypeError("source.reply must be a function");
  }

  const pending = new Map();
  const inFlight = new Set();
  const settled = new Set();

  function list() {
    return [...pending.values()];
  }

  function get(id) {
    return pending.get(id);
  }

  function has(id) {
    return pending.has(id);
  }

  function add(request) {
    if (!request || !validId(request.id)) return false;
    if (settled.has(request.id) || inFlight.has(request.id)) return false;
    pending.set(request.id, request);
    return true;
  }

  function remove(id) {
    return pending.delete(id);
  }

  function replace(requests) {
    const next = new Map();
    if (Array.isArray(requests)) {
      for (const request of requests) {
        if (!request || !validId(request.id)) continue;
        if (settled.has(request.id) || inFlight.has(request.id)) continue;
        next.set(request.id, request);
      }
    }
    pending.clear();
    for (const [id, request] of next) pending.set(id, request);
    return list();
  }

  async function reply(id, decision) {
    if (!validId(id)) return null;
    if (!ALLOWED.has(decision)) {
      throw new TypeError("decision must be once, always, or reject");
    }
    if (settled.has(id) || inFlight.has(id)) return null;
    if (!pending.has(id) && typeof source.list === "function") {
      replace(await source.list());
    }
    if (!pending.has(id) || settled.has(id) || inFlight.has(id)) return null;

    const request = pending.get(id);
    pending.delete(id);
    inFlight.add(id);

    try {
      await source.reply(id, decision);
    } catch (error) {
      inFlight.delete(id);
      pending.set(id, request);
      throw error;
    }

    inFlight.delete(id);
    settled.add(id);

    if (desktop && typeof desktop.close === "function") {
      try {
        desktop.close(id);
      } catch {}
    }
    return request;
  }

  return { pending, list, get, has, add, remove, replace, reply };
}
