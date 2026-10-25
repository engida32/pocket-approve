const DB_NAME = "pocket-approve";
const DB_VERSION = 2;
const SESSION_STORE = "session";
const SESSION_KEY = "current";
const ACTIONS = [
  { action: "reject", title: "Deny" },
  { action: "review", title: "Review" },
];

function openDb() {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains("auth")) db.deleteObjectStore("auth");
      if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE);
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error("indexedDB upgrade blocked by an older connection"));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      resolve(db);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("indexedDB open failed"));
    };
  });
}

async function readSession() {
  let db;
  try {
    db = await openDb();
    return await new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let tx;
      try {
        tx = db.transaction(SESSION_STORE, "readonly");
      } catch {
        done(null);
        return;
      }
      const request = tx.objectStore(SESSION_STORE).get(SESSION_KEY);
      request.onsuccess = () => done(request.result ?? null);
      request.onerror = () => done(null);
      tx.onabort = () => done(null);
      tx.onerror = () => done(null);
    });
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

async function clearSession() {
  let db;
  try {
    db = await openDb();
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      let tx;
      try {
        tx = db.transaction(SESSION_STORE, "readwrite");
      } catch {
        done();
        return;
      }
      tx.objectStore(SESSION_STORE).delete(SESSION_KEY);
      tx.oncomplete = done;
      tx.onerror = done;
      tx.onabort = done;
    });
  } catch {
    // The app re-pairs on the next open.
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

async function reply(session, id, decision) {
  if (!session?.token) return { status: 401, code: "unauthorized" };
  try {
    const response = await fetch("/api/reply", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ id, decision }),
    });
    let body = {};
    try {
      body = await response.json();
    } catch {}
    return { status: response.status, code: body?.error ?? null };
  } catch {
    return { status: 0, code: "offline" };
  }
}

async function subscribeAgain(session) {
  if (!session?.token || !self.registration?.pushManager) return;
  const keyResponse = await fetch("/api/vapid-public-key", {
    credentials: "same-origin",
    cache: "no-store",
    headers: { authorization: `Bearer ${session.token}` },
  });
  if (!keyResponse.ok) return;
  const { publicKey } = await keyResponse.json();
  const subscription = await self.registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(publicKey),
  });
  await fetch("/api/subscribe", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function requestUrl(id) {
  return id ? `/?request=${encodeURIComponent(id)}` : "/";
}

async function openApp(path) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const target = new URL(path, self.location.origin);
  const existing = windows.find((client) => new URL(client.url).origin === target.origin);
  if (existing) {
    await existing.focus();
    if (typeof existing.navigate === "function") await existing.navigate(target.href);
    return;
  }
  await self.clients.openWindow(target.href);
}

async function failPath(code) {
  return `/?error=${encodeURIComponent(code)}`;
}

self.addEventListener("install", () => {
  // A new worker waits until the page shows the update prompt.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try {
      payload = event.data?.json() ?? {};
    } catch {
      payload = {};
    }
    const kind = payload.kind === "request" ? "request" : payload.kind === "digest" ? "digest" : "test";
    const body = String(payload.summary || "Open Pocket Approve to review.").slice(0, 180);
    const count = Number.isInteger(payload.count) ? payload.count : 1;
    const options = {
      body: kind === "digest" ? `${count} new permission requests` : body,
      icon: "/icon-192.png",
      tag: payload.id ? String(payload.id) : undefined,
      data: {
        kind,
        id: payload.id ?? null,
        serverId: payload.serverId ?? null,
        url: kind === "request" ? requestUrl(payload.id) : "/",
      },
      renotify: false,
      requireInteraction: false,
      silent: false,
    };
    if (kind === "request") options.actions = ACTIONS;
    await self.registration.showNotification(String(payload.title || "Pocket Approve").slice(0, 64), options);
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = event.notification.data ?? {};
    const action = event.action;
    if (!action || action === "review") {
      await openApp(data.url || requestUrl(data.id));
      return;
    }
    if (action !== "reject") return;
    const session = await readSession();
    if (!session?.token) {
      const target = data.kind === "request" && data.id
        ? `/pair?request=${encodeURIComponent(data.id)}`
        : "/pair";
      await openApp(target);
      return;
    }
    const result = await reply(session, data.id, "reject");
    if (result.status === 401) {
      await clearSession();
      await openApp(await failPath("auth"));
      return;
    }
    if (result.status === 404 || result.status === 409) {
      await openApp(await failPath("answered"));
      return;
    }
    if (result.status === 502 || result.status === 0) {
      await openApp(await failPath("offline"));
      return;
    }
    if (result.status === 200) return;
    await openApp(await failPath("offline"));
  })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const session = await readSession();
    try {
      await subscribeAgain(session);
    } catch {
      // The app re-posts its subscription on the next open.
    }
  })());
});
