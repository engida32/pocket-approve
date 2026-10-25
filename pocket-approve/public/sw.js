const DB_NAME = "pocket-approve";
const DB_VERSION = 1;
const AUTH_STORE = "auth";
const TOKEN_RECORD_KEY = "token";
const FALLBACK_MAX_ACTIONS = 2;

const ACTIONS = [
  { action: "once", title: "Allow once" },
  { action: "reject", title: "Deny" },
  { action: "always", title: "Allow always" },
];
const DECISIONS = new Set(ACTIONS.map((entry) => entry.action));

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function readToken() {
  return new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve("");
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(AUTH_STORE)) {
        db.createObjectStore(AUTH_STORE);
      }
    };
    request.onerror = () => resolve("");
    request.onsuccess = () => {
      const db = request.result;
      let get;
      try {
        get = db
          .transaction(AUTH_STORE, "readonly")
          .objectStore(AUTH_STORE)
          .get(TOKEN_RECORD_KEY);
      } catch {
        db.close();
        resolve("");
        return;
      }
      get.onsuccess = () => {
        const value = get.result;
        db.close();
        resolve(typeof value === "string" ? value : "");
      };
      get.onerror = () => {
        db.close();
        resolve("");
      };
    };
  });
}

async function postReply(requestId, decision) {
  const token = await readToken();
  if (!token) return false;
  let response;
  try {
    response = await fetch(new URL("/api/reply", self.location.origin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: requestId, decision }),
    });
  } catch {
    return false;
  }
  return response.ok || response.status === 404;
}

async function openApp() {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of windows) {
    if (client.url.startsWith(self.registration.scope) && "focus" in client) {
      return client.focus();
    }
  }
  return self.clients.openWindow("/");
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  if (!payload || typeof payload !== "object") payload = {};

  const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
  const title =
    typeof payload.title === "string" && payload.title.length > 0
      ? payload.title
      : "Pocket Approve";
  const summary =
    typeof payload.summary === "string" && payload.summary.length > 0
      ? payload.summary
      : "A permission request is waiting for an answer.";

  const maxActions = Number.isInteger(self.Notification?.maxActions)
    ? self.Notification.maxActions
    : FALLBACK_MAX_ACTIONS;
  const actions = ACTIONS.slice(0, Math.max(0, maxActions));

  const options = {
    body: summary,
    tag: requestId || "pocket-approve",
    data: { requestId },
    icon: "/icon.svg",
  };
  if (actions.length > 0) options.actions = actions;

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.waitUntil(
    (async () => {
      const action = event.action;
      if (!action) {
        event.notification.close();
        await openApp();
        return;
      }
      if (!DECISIONS.has(action)) return;

      const data = event.notification.data ?? {};
      const requestId = typeof data.requestId === "string" ? data.requestId : "";
      if (!requestId) return;

      if (await postReply(requestId, action)) {
        event.notification.close();
      }
    })(),
  );
});
