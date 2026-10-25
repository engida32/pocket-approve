import { createHash, randomUUID } from "node:crypto";

const DIGEST_THRESHOLD = 10;
const MAX_TITLE = 64;
const MAX_SUMMARY = 140;
const MAX_LABEL = 32;
const MAX_BODY_BYTES = 3584;
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

function requestPayload(item, count) {
  return {
    id: item.id,
    serverId: item.serverId,
    serverLabel: cap(item.serverLabel, MAX_LABEL),
    title: cap(`[${cap(item.serverLabel, MAX_LABEL)}] ${item.title}`, MAX_TITLE),
    summary: cap(item.summary, MAX_SUMMARY),
    count,
    kind: "request",
  };
}

function digestPayload(serverLabel, count) {
  const id = `digest:${randomUUID()}`;
  return {
    id,
    serverId: null,
    serverLabel: cap(serverLabel, MAX_LABEL),
    title: cap(`${cap(serverLabel, MAX_LABEL)}: ${count} new requests`, MAX_TITLE),
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
  now = () => Date.now(),
  log = console,
} = {}) {
  for (const [name, value] of Object.entries({ fleet, seen, push, devices, desktop })) {
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

  async function announce(link) {
    const snapshot = fleet.pending();
    const activeIds = new Set(snapshot.requests.map((item) => item.id));
    await seen.observe(activeIds);
    const mine = snapshot.requests.filter((item) => item.serverId === link?.id);
    const fresh = await seen.takeNew(mine);
    if (fresh.length === 0) return { desktop: 0, pushes: 0, digest: false };

    const label = link?.label ?? fresh[0]?.serverLabel ?? "";

    if (fresh.length > DIGEST_THRESHOLD) {
      const payload = shrink(digestPayload(label, fresh.length));
      let pushes = 0;
      try {
        pushes = await pushToDevices(payload);
      } catch (error) {
        logError("notifications: digest push failed", error);
      }
      if (typeof desktop?.notify === "function") {
        Promise.resolve(
          desktop.notify({
            id: payload.id,
            title: payload.title,
            summary: payload.summary,
            actions: false,
          }),
        ).catch((error) => logError("notifications: digest desktop failed", error));
      }
      return { desktop: 1, pushes, digest: true };
    }

    let notes = 0;
    for (const item of fresh) {
      const payload = shrink(requestPayload(item, fresh.length));
      let answer = null;
      try {
        answer = await desktop.notify?.({
          id: item.id,
          title: payload.title,
          summary: payload.summary,
        });
        notes += 1;
      } catch (error) {
        logError(`notifications: desktop failed for ${item.id}`, error);
      }
      if (answer && DECISIONS.has(answer.decision)) {
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
      }
    }

    let pushes = 0;
    try {
      pushes = await pushToDevices(shrink(requestPayload(fresh[0], fresh.length)));
    } catch (error) {
      logError("notifications: push failed", error);
    }
    return { desktop: notes, pushes, digest: false };
  }

  async function sendTest(deviceId = null) {
    const id = `test:${randomUUID()}`;
    const payload = shrink({
      id,
      serverId: null,
      serverLabel: "Pocket Approve",
      title: "Test notification",
      summary: "If you can read this, push is working.",
      count: fleet.pending().requests.length,
      kind: "test",
    });
    const result = await push.send(payload, {
      deviceId: deviceId ?? null,
      options: optionsFor(payload),
    });
    await audit?.append("test_notification", {
      deviceId: deviceId ?? undefined,
      result: `${result.sent}/${result.failed}`,
    });
    return { sent: result.sent, failed: result.failed, pruned: result.removed };
  }

  return { announce, sendTest, buildPayload: requestPayload, shrinkPayload: shrink, optionsFor };
}
