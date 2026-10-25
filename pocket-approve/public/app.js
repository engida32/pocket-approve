const TOKEN_STORAGE_KEY = "pocketApproveToken";
const DB_NAME = "pocket-approve";
const DB_VERSION = 1;
const AUTH_STORE = "auth";
const TOKEN_RECORD_KEY = "token";
const POLL_MS = 4000;
const POLL_ERROR_MS = 8000;
const NOTICE_MS = 10_000;

const DECISIONS = [
  ["once", "Allow once"],
  ["reject", "Deny"],
  ["always", "Allow always"],
];

const state = {
  token: "",
  unauthorized: false,
  loading: false,
  timer: null,
  noticeTimer: null,
  requests: [],
  busy: new Set(),
  registration: null,
  connected: false,
};

const els = {
  status: document.getElementById("status"),
  notice: document.getElementById("notice"),
  enable: document.getElementById("enable-notifications"),
  test: document.getElementById("send-test"),
  pending: document.getElementById("pending"),
  empty: document.getElementById("empty"),
};

class ApiError extends Error {
  constructor(status, cause) {
    super(status ? `request failed with status ${status}` : "network request failed", {
      cause,
    });
    this.status = status;
  }
}

function setStatus(text) {
  els.status.textContent = text;
}

function setNotice(text) {
  els.notice.textContent = text;
  clearTimeout(state.noticeTimer);
  if (text) {
    state.noticeTimer = setTimeout(() => {
      els.notice.textContent = "";
    }, NOTICE_MS);
  }
}

function tokenFromHash() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = params.get("token");
  return token ? token.trim() : "";
}

function clearHash() {
  if (window.location.hash) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(AUTH_STORE)) {
        db.createObjectStore(AUTH_STORE);
      }
    };
    request.onblocked = () => reject(new Error("IndexedDB blocked"));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readStoredToken() {
  try {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const request = db
          .transaction(AUTH_STORE, "readonly")
          .objectStore(AUTH_STORE)
          .get(TOKEN_RECORD_KEY);
        request.onsuccess = () => {
          resolve(typeof request.result === "string" ? request.result : "");
        };
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  } catch {
    return "";
  }
}

async function writeStoredToken(token) {
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(AUTH_STORE, "readwrite");
      transaction.objectStore(AUTH_STORE).put(token, TOKEN_RECORD_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

async function storeToken(token) {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {}
  try {
    await writeStoredToken(token);
  } catch (error) {
    console.error("Pocket Approve: could not save the token in IndexedDB", error);
  }
}

async function resolveToken() {
  const fromHash = tokenFromHash();
  if (fromHash) {
    clearHash();
    await storeToken(fromHash);
    return fromHash;
  }
  let local = "";
  try {
    local = localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  } catch {}
  const stored = await readStoredToken();
  const token = local || stored;
  if (token) await storeToken(token);
  return token;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${state.token}`);
  if (typeof options.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  let response;
  try {
    response = await fetch(path, { ...options, headers, cache: "no-store" });
  } catch (error) {
    throw new ApiError(0, error);
  }
  return response;
}

function schedule(ms) {
  clearTimeout(state.timer);
  state.timer = setTimeout(loadPending, ms);
}

async function loadPending() {
  if (state.loading || state.unauthorized || !state.token) return;
  state.loading = true;
  clearTimeout(state.timer);
  let delay = POLL_MS;
  try {
    const response = await api("/api/pending");
    if (response.status === 401) {
      state.unauthorized = true;
      state.connected = false;
      setStatus("Token rejected. Open the setup link again with the current token.");
      return;
    }
    if (!response.ok) throw new ApiError(response.status);
    const data = await response.json();
    if (!Array.isArray(data)) throw new ApiError(0);
    state.connected = true;
    render(data);
  } catch (error) {
    state.connected = false;
    delay = POLL_ERROR_MS;
    if (error instanceof ApiError && error.status) {
      setStatus(`Server error (${error.status}). Retrying.`);
    } else {
      setStatus("Cannot reach the server. Retrying.");
    }
  } finally {
    state.loading = false;
    if (!state.unauthorized) schedule(delay);
  }
}

function render(requests) {
  state.requests = Array.isArray(requests) ? requests : [];
  els.pending.replaceChildren();
  let count = 0;
  for (const request of state.requests) {
    if (!request || typeof request.id !== "string" || request.id.length === 0) continue;
    els.pending.append(renderRequest(request));
    count++;
  }
  els.empty.hidden = count > 0;
  if (state.connected) {
    setStatus(count === 0 ? "Connected. No pending requests." : `Connected. ${count} pending.`);
  }
}

function renderRequest(request) {
  const item = document.createElement("li");
  item.className = "request";
  item.dataset.id = request.id;

  const title = document.createElement("h3");
  title.textContent =
    typeof request.title === "string" && request.title.length > 0
      ? request.title
      : "Permission request";

  const summary = document.createElement("p");
  summary.className = "summary";
  summary.textContent =
    typeof request.summary === "string" && request.summary.length > 0
      ? request.summary
      : "No details.";

  const decisions = document.createElement("div");
  decisions.className = "decisions";
  const busy = state.busy.has(request.id);
  for (const [decision, label] of DECISIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = busy;
    button.addEventListener("click", () => {
      void reply(request.id, decision, label);
    });
    decisions.append(button);
  }

  item.append(title, summary, decisions);
  return item;
}

function removeRequest(id) {
  state.requests = state.requests.filter((request) => request?.id !== id);
  render(state.requests);
}

async function reply(id, decision, label) {
  if (state.busy.has(id) || state.unauthorized) return;
  state.busy.add(id);
  render(state.requests);
  try {
    const response = await api("/api/reply", {
      method: "POST",
      body: JSON.stringify({ id, decision }),
    });
    if (response.status === 200) {
      setNotice(`Answered: ${label}.`);
      state.busy.delete(id);
      removeRequest(id);
      await loadPending();
      return;
    }
    if (response.status === 404) {
      setNotice("That request is no longer pending.");
      state.busy.delete(id);
      removeRequest(id);
      await loadPending();
      return;
    }
    if (response.status === 401) {
      state.unauthorized = true;
      state.connected = false;
      state.busy.delete(id);
      render(state.requests);
      setStatus("Token rejected. Open the setup link again with the current token.");
      setNotice("The server rejected the token, so nothing was answered.");
      return;
    }
    setNotice(`The server could not record that answer (${response.status}). Try again.`);
  } catch {
    setNotice("Cannot reach the server. Try again.");
  }
  state.busy.delete(id);
  render(state.requests);
}

function decodeBase64Url(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

function pushSupported() {
  return (
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

async function registerWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
    });
    state.registration = registration;
    return registration;
  } catch (error) {
    console.error("Pocket Approve: service worker registration failed", error);
    state.registration = null;
    return null;
  }
}

async function activeRegistration() {
  if (!state.registration) {
    const registered = await registerWorker();
    if (!registered) throw new Error("the service worker was not registered");
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("the service worker did not start"));
    }, 10_000);
    navigator.serviceWorker.ready.then(
      (registration) => {
        clearTimeout(timer);
        resolve(registration);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function refreshNotificationButton() {
  if (!pushSupported()) {
    els.enable.textContent = "Notifications not supported";
    els.enable.disabled = true;
    return;
  }
  if (Notification.permission === "denied") {
    els.enable.textContent = "Notifications blocked";
    els.enable.disabled = false;
    return;
  }
  let subscription = null;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    subscription = await registration?.pushManager.getSubscription();
  } catch {}
  els.enable.textContent = subscription ? "Notifications on" : "Enable notifications";
  els.enable.disabled = false;
}

async function enableNotifications() {
  if (!pushSupported()) {
    setNotice("This browser does not support notifications from a web app.");
    return;
  }
  els.enable.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setNotice(
        permission === "denied"
          ? "Notifications are blocked in your browser settings."
          : "Notification permission was not granted.",
      );
      return;
    }

    const registration = await activeRegistration();
    const keyResponse = await api("/api/vapid-public-key");
    if (!keyResponse.ok) {
      setNotice(`Could not read the push key from the server (${keyResponse.status}).`);
      return;
    }
    const keyData = await keyResponse.json();
    const publicKey = typeof keyData?.publicKey === "string" ? keyData.publicKey : "";
    if (!publicKey) {
      setNotice("The server has no push key. Run the setup command again.");
      return;
    }

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeBase64Url(publicKey),
      });
    }

    const response = await api("/api/subscribe", {
      method: "POST",
      body: JSON.stringify(subscription.toJSON()),
    });
    if (!response.ok) {
      setNotice(`The server did not save this subscription (${response.status}).`);
      return;
    }
    setNotice("Notifications are enabled on this device.");
  } catch (error) {
    setNotice(`Could not enable notifications: ${error?.message ?? "unknown error"}.`);
  } finally {
    await refreshNotificationButton();
  }
}

async function sendTest() {
  if (!state.token) return;
  els.test.disabled = true;
  try {
    const response = await api("/api/test-notification", {
      method: "POST",
      body: "{}",
    });
    if (!response.ok) {
      setNotice(`The test notification failed (${response.status}).`);
      return;
    }
    const result = await response.json();
    const sent = Number(result?.sent) || 0;
    const failed = Number(result?.failed) || 0;
    if (sent === 0 && failed === 0) {
      setNotice("No devices are subscribed. Enable notifications first.");
    } else if (failed > 0) {
      setNotice(`Sent to ${sent} and failed for ${failed}.`);
    } else {
      setNotice(`Sent to ${sent} ${sent === 1 ? "device" : "devices"}.`);
    }
  } catch {
    setNotice("Cannot reach the server to send a test notification.");
  } finally {
    els.test.disabled = false;
  }
}

function wireEvents() {
  els.enable.addEventListener("click", () => {
    void enableNotifications();
  });
  els.test.addEventListener("click", () => {
    void sendTest();
  });
  window.addEventListener("hashchange", () => {
    const token = tokenFromHash();
    if (!token) return;
    clearHash();
    void (async () => {
      await storeToken(token);
      state.token = token;
      state.unauthorized = false;
      state.connected = false;
      els.test.disabled = false;
      await registerWorker();
      await refreshNotificationButton();
      setNotice("Token updated.");
      await loadPending();
    })();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.token && !state.unauthorized) {
      void loadPending();
    }
  });
}

async function init() {
  wireEvents();
  state.token = await resolveToken();
  if (!state.token) {
    setStatus("No token. Open the link printed by npm run setup, which ends in #token=.");
    els.enable.disabled = true;
    els.test.disabled = true;
    return;
  }

  await registerWorker();
  await refreshNotificationButton();
  setStatus("Connecting.");
  await loadPending();
}

void init();
