import { createHash, randomUUID } from "node:crypto";

const DIGEST_THRESHOLD = 10;
const MAX_TITLE = 64;
const MAX_SUMMARY = 140;
const MAX_LABEL = 32;
const MAX_BODY_BYTES = 3584;
const NTFY_BATCH = 20;
const DECISIONS = new Set(["once", "always", "reject"]);

function cap(value, max) {
  const text = typeof value === "string" ? value : "";
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return text.slice(0, max - 3) + "...";
}

function topicFor(id) {
  return createHash("sha256").update(id).digest("base64url").slice(0, 32);
}

function desktopTitle(item) {
  return cap(`[${cap(item.serverLabel, MAX_LABEL)}] ${item.title}`, MAX_TITLE);
}

function requestPayload(item, count) {
  return {
    id: item.id,
    serverId: item.serverId,
    serverLabel: cap(item.serverLabel, MAX_LABEL),
    title: cap(item.title, MAX_TITLE),
    summary: cap(item.summary, MAX_SUMMARY),
    count,
    kind: "request",
  };
}

function digestPayload(serverLabel, newCount, count) {
  const id = `digest:${randomUUID()}`;
  return {
    id,
    serverId: null,
    serverLabel: cap(serverLabel, MAX_LABEL),
    title: cap(`${cap(serverLabel, MAX_LABEL)}: ${newCount} new requests`, MAX_TITLE),
    summary: "Open Pocket Approve to review them.",
    count,
    kind: "digest",
  };
}

function fits(payload) {
  return Buffer.byteLength(JSON.stringify(payload)) < MAX_BODY_BYTES;
}

function shrink(payload) {
  const copy = { ...payload };
  while (!fits(copy) && typeof copy.summary === "string" && copy.summary.length > 0) {
    const keep = Math.max(0, copy.summary.length - 20);
    copy.summary = keep === 0 ? "" : copy.summary.slice(0, keep) + "...";
  }
  if (!fits(copy)) copy.summary = "";
  return copy;
}

export { shrink as shrinkPayload };

export function createNotifications({
  fleet,
  seen,
  push,
  devices,
  desktop,
  audit,
  ntfy,
  digest = true,
  log = console,
} = {}) {
  const required = { fleet, seen, desktop };
  if (!ntfy) {
    required.push = push;
    required.devices = devices;
  }
  for (const [name, value] of Object.entries(required)) {
    if (!value) throw new TypeError(`${name} is required`);
  }

  function optionsFor(payload) {
    return {
      TTL: 600,
      urgency: "high",
      topic: topicFor(payload.id),
    };
  }

  function logError(message, error) {
    try {
      log?.error?.(message, error);
    } catch {}
  }

  async function pushToDevices(payload) {
    const active = devices.list().filter((device) => device && device.revokedAt === null);
    let pushes = 0;
    for (const device of active) {
      const result = await push.send(payload, {
        deviceId: device.id,
        options: optionsFor(payload),
      });
      pushes += result.sent;
    }
    const legacy = push.listForDevice(null);
    if (legacy.length > 0) {
      const result = await push.send(payload, { options: optionsFor(payload) });
      pushes += result.sent;
    }
    return pushes;
  }

  function notifyDesktop(item, title, summary, extra = {}) {
    if (typeof desktop?.notify !== "function") return false;
    let pending;
    try {
      pending = desktop.notify({ id: item.id, title, summary, ...extra });
    } catch (error) {
      logError(`notifications: desktop failed for ${item.id}`, error);
      return true;
    }
    Promise.resolve(pending)
      .then(async (answer) => {
        if (!answer || !DECISIONS.has(answer.decision)) return;
        try {
          const result = await fleet.reply(item.id, answer.decision);
          await audit?.append("reply", {
            deviceId: "desktop",
            serverId: item.serverId,
            requestId: item.id,
            result: String(result.status),
          });
        } catch (error) {
          logError(`notifications: reply failed for ${item.id}`, error);
        }
      })
      .catch((error) => logError(`notifications: desktop failed for ${item.id}`, error));
    return true;
  }

  async function announce(link) {
    const { requests } = await fleet.pending();
    const totalPending = requests.length;
    const activeIds = new Set(requests.map((item) => item.id));
    await seen.observe(activeIds);
    const mine = requests.filter((item) => item.serverId === link?.id);
    const candidates = ntfy ? mine.slice(0, NTFY_BATCH) : mine;
    const fresh = await seen.takeNew(candidates);
    if (fresh.length === 0) return { desktop: 0, pushes: 0, digest: false, ntfy: 0 };

    if (!ntfy && digest && fresh.length > DIGEST_THRESHOLD) {
      const payload = shrink(digestPayload(fresh[0].serverLabel, fresh.length, totalPending));
      let pushes = 0;
      if (fits(payload)) pushes = await pushToDevices(payload);
      else log.warn?.("digest payload is too large to push");
      const desktopAttempt = await notifyDesktop(
        { id: payload.id, serverId: link?.id, serverLabel: fresh[0].serverLabel },
        payload.title,
        payload.summary,
        { actions: false },
      );
      return { desktop: desktopAttempt ? 1 : 0, pushes, digest: true, ntfy: 0 };
    }

    let desktopCount = 0;
    let pushCount = 0;
    let ntfyCount = 0;
    for (const item of fresh) {
      const title = desktopTitle(item);
      if (await notifyDesktop(item, title, item.summary)) desktopCount += 1;

      if (ntfy) {
        try {
          await ntfy.publishRequest(item, { count: totalPending });
          ntfyCount += 1;
        } catch (error) {
          log.error?.(`ntfy publish failed for ${item.id}: ${error.message}`);
          await seen.release([item.id]);
        }
      } else {
        const payload = shrink(requestPayload(item, totalPending));
        if (!fits(payload)) {
          log.warn?.(`notification payload is too large for ${item.id}`);
          continue;
        }
        pushCount += await pushToDevices(payload);
      }
    }
    return { desktop: desktopCount, pushes: pushCount, digest: false, ntfy: ntfyCount };
  }

  async function sendTest(deviceId = null) {
    if (ntfy) {
      try {
        const { id } = await ntfy.sendTest();
        audit.append("test_notification", { deviceId: "ntfy", requestId: id, result: "sent" });
        return { sent: 1, failed: 0, pruned: 0, id };
      } catch (error) {
        audit.append("test_notification", { deviceId: "ntfy", result: "failed" });
        return { sent: 0, failed: 1, pruned: 0 };
      }
    }
    const payload = {
      id: `test:${randomUUID()}`,
      title: "Test notification",
      summary: "If you can read this, push is working.",
      count: 0,
      kind: "test",
    };
    if (!fits(payload)) throw new Error("test notification is too large");
    const result = await push.send(payload, { deviceId: deviceId ?? null, options: optionsFor(payload) });
    audit.append("test_notification", {
      deviceId,
      requestId: payload.id,
      result: `${result.sent}/${result.failed}`,
    });
    return { sent: result.sent, failed: result.failed, pruned: result.removed };
  }

  return { announce, sendTest, buildPayload: requestPayload, shrinkPayload: shrink, optionsFor };
}
