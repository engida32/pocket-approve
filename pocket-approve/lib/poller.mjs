const DEFAULT_INTERVAL_MS = 2000;

function requestId(request) {
  const id = request?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function createPoller({
  source,
  onNew,
  intervalMs = DEFAULT_INTERVAL_MS,
  log = console,
} = {}) {
  if (!source || typeof source.list !== "function") {
    throw new TypeError("source.list must be a function");
  }
  if (typeof onNew !== "function") {
    throw new TypeError("onNew must be a function");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError("intervalMs must be a positive number");
  }

  const known = new Set();
  let timer = null;
  let current = null;
  let failing = false;

  function logError(message, error) {
    try {
      if (log && typeof log.error === "function") {
        log.error(message, error);
      }
    } catch {}
  }

  async function run() {
    let requests;
    try {
      requests = await source.list();
      failing = false;
    } catch (error) {
      if (!failing) {
        failing = true;
        logError("poller: could not list pending requests", error);
      }
      return [];
    }

    const next = new Set();
    const fresh = [];
    if (Array.isArray(requests)) {
      for (const request of requests) {
        const id = requestId(request);
        if (id === null || next.has(id)) continue;
        next.add(id);
        if (!known.has(id)) fresh.push(request);
      }
    }

    known.clear();
    for (const id of next) known.add(id);

    for (const request of fresh) {
      try {
        await onNew(request);
      } catch (error) {
        logError(`poller: handler failed for request ${request.id}`, error);
      }
    }

    return fresh;
  }

  function tick() {
    if (current) return current;
    current = run().finally(() => {
      current = null;
    });
    return current;
  }

  function start() {
    if (timer) return current ?? Promise.resolve();
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
    timer.unref?.();
    return tick();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return current;
  }

  return { start, stop, tick };
}
