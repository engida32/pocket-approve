const DB_NAME = "pocket-approve";
const DB_VERSION = 2;
const SESSION_KEY = "current";
const POLL_MS = 10_000;
const ERROR_POLL_MS = 20_000;

const decisions = [
  { id: "once", label: "Allow once" },
  { id: "reject", label: "Deny" },
  { id: "always", label: "Allow always" },
];

const state = {
  session: null,
  requests: [],
  servers: [],
  fetchedAt: null,
  busy: new Set(),
  timer: null,
  noticeTimer: null,
  registration: null,
  focusId: null,
  deepLinkHandled: false,
  reloading: false,
};

const els = {
  installGate: document.querySelector("#install-gate"),
  pairSection: document.querySelector("#pair-section"),
  pairForm: document.querySelector("#pair-form"),
  pairCode: document.querySelector("#pair-code"),
  deviceName: document.querySelector("#device-name"),
  pairButton: document.querySelector("#pair-button"),
  pairError: document.querySelector("#pair-error"),
  appSection: document.querySelector("#app-section"),
  offline: document.querySelector("#offline-banner"),
  offlineText: document.querySelector("#offline-text"),
  count: document.querySelector("#pending-count"),
  pending: document.querySelector("#pending"),
  empty: document.querySelector("#empty"),
  settingsButton: document.querySelector("#settings-button"),
  settings: document.querySelector("#settings-dialog"),
  deviceSummary: document.querySelector("#device-summary"),
  enable: document.querySelector("#enable-notifications"),
  test: document.querySelector("#send-test"),
  unpair: document.querySelector("#unpair-button"),
  closeSettings: document.querySelector("#close-settings"),
  pushStatus: document.querySelector("#push-status"),
  always: document.querySelector("#always-dialog"),
  alwaysConfirm: document.querySelector("#always-confirm"),
  alwaysCancel: document.querySelector("#always-cancel"),
  update: document.querySelector("#update-banner"),
  updateButton: document.querySelector("#update-button"),
  status: document.querySelector("#status"),
  notice: document.querySelector("#notice"),
};

class ApiError extends Error {
  constructor(status, code, payload) {
    super(code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

function setStatus(text) {
  if (els.status) els.status.textContent = text;
}

function notice(text, ms = 10_000) {
  if (!els.notice) return;
  clearTimeout(state.noticeTimer);
  state.noticeTimer = null;
  els.notice.textContent = text;
  els.notice.hidden = !text;
  if (text) {
    state.noticeTimer = setTimeout(() => {
      els.notice.textContent = "";
      els.notice.hidden = true;
      state.noticeTimer = null;
    }, ms);
  }
}

function setPairError(text) {
  if (!els.pairError) return;
  els.pairError.textContent = text;
  els.pairError.hidden = !text;
}

function renderDeviceSummary(paired) {
  if (!els.deviceSummary) return;
  els.deviceSummary.textContent = paired ? state.session.deviceName || "This device" : "";
}

function isIos() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

function isInstalledContext() {
  return !isIos() || isStandalone();
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("session")) {
        request.result.createObjectStore("session");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readSession() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("session", "readonly");
    const request = tx.objectStore("session").get(SESSION_KEY);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

async function writeSession(value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("session", "readwrite");
    tx.objectStore("session").put(value, SESSION_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function clearSession() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("session", "readwrite");
    tx.objectStore("session").delete(SESSION_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (state.session?.token) headers.authorization = `Bearer ${state.session.token}`;
  if (options.body) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok) throw new ApiError(response.status, payload?.error, payload);
  return payload;
}

function renderSession() {
  const paired = Boolean(state.session?.token);
  els.installGate.hidden = isInstalledContext();
  els.pairSection.hidden = paired || !isInstalledContext();
  els.appSection.hidden = !paired;
  els.settingsButton.hidden = !paired;
  renderDeviceSummary(paired);
  if (!paired && isInstalledContext()) {
    const stored = sessionStorage.getItem("pending-pair-code");
    if (stored) {
      els.pairCode.value = stored;
      sessionStorage.removeItem("pending-pair-code");
    }
  }
  if (paired) loadPending();
}

function pairFromHash() {
  if (!location.hash) return false;
  const params = new URLSearchParams(location.hash.slice(1));
  const code = params.get("code");
  if (code) sessionStorage.setItem("pending-pair-code", code);
  const legacy = params.get("token");
  history.replaceState(null, "", location.pathname + location.search);
  return { code, legacy };
}

async function boot() {
  const hash = pairFromHash();
  if (hash?.legacy) {
    const existing = await readSession();
    if (!existing || existing.origin !== location.origin) {
      await writeSession({ token: hash.legacy, origin: location.origin, deviceId: null, deviceName: "Legacy token", pairedAt: new Date().toISOString() });
    }
  }
  state.session = await readSession();
  if (state.session && state.session.origin !== location.origin) {
    await clearSession();
    state.session = null;
    notice("This app was paired with a different address. Pair this device again.");
  }
  wireEvents();
  renderSession();
  if (!state.session) {
    if (new URLSearchParams(location.search).get("error") === "auth") {
      setPairError("This device was disconnected. Pair again.");
      history.replaceState(null, "", location.pathname);
    }
    return;
  }
  await setupWorker();
  await loadPending();
  refreshVapidFingerprint().catch(() => {});
  refreshSubscription().catch(() => {});
}

async function pair(event) {
  event.preventDefault();
  setPairError("");
  els.pairButton.disabled = true;
  const code = els.pairCode.value.trim();
  const deviceName = els.deviceName.value.trim();
  if (!code || !deviceName) {
    setPairError("Enter the pairing code and a device name.");
    els.pairButton.disabled = false;
    return;
  }
  try {
    const result = await api("/api/pair", {
      method: "POST",
      body: JSON.stringify({ code, deviceName }),
    });
    state.session = {
      token: result.token,
      origin: location.origin,
      deviceId: result.device.id,
      deviceName: result.device.name,
      pairedAt: new Date().toISOString(),
      pushFingerprint: null,
      pushOrigin: null,
    };
    await writeSession(state.session);
    els.pairForm.reset();
    setPairError("");
    setStatus("This device is paired.");
    renderSession();
    await setupWorker();
    await loadPending();
  } catch (error) {
    if (error.status === 410) setPairError("Pairing code expired. Run npm run pair again.");
    else if (error.status === 429) setPairError("Too many attempts. Wait a minute and try again.");
    else setPairError("That pairing code did not work. Check the code and try again.");
  } finally {
    els.pairButton.disabled = false;
  }
}

function serverById(id) {
  return state.servers.find((server) => server.id === id) ?? null;
}

function serverState(server) {
  if (!server) return "unknown";
  if (server.lastError === "disabled") return "disabled";
  return server.ok ? "online" : "offline";
}

function render() {
  els.pending.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const request of state.requests) fragment.append(renderRequest(request));
  els.pending.append(fragment);
  const count = state.requests.length;
  els.count.textContent = count === 0 ? "No requests" : `${count} waiting`;
  els.empty.hidden = count !== 0;
  const offline = state.servers.filter((server) => !server.ok && server.lastError !== "disabled");
  els.offline.hidden = offline.length === 0;
  els.offlineText.textContent = offline.length
    ? `Offline: ${offline.map((server) => server.label || server.id).join(", ")}. Showing the last known requests.`
    : "";
  if ("setAppBadge" in navigator) {
    if (count > 0) navigator.setAppBadge(count).catch(() => {});
    else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  }
  applyDeepLink();
}

function renderRequest(request) {
  const item = document.createElement("li");
  item.className = "request card";
  item.dataset.requestId = request.id;

  const head = document.createElement("div");
  head.className = "card-head";
  const pill = document.createElement("span");
  pill.className = `server-chip ${serverState(serverById(request.serverId))}`;
  pill.textContent = request.serverLabel || request.serverId;
  const when = document.createElement("time");
  when.dateTime = request.firstSeen ?? "";
  when.title = request.firstSeen ? new Date(request.firstSeen).toLocaleString() : "";
  when.textContent = relativeTime(request.firstSeen);
  head.append(pill, when);

  const title = document.createElement("h3");
  title.tabIndex = -1;
  title.id = `request-${request.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  title.textContent = request.title || request.permission || "Permission request";

  const summary = document.createElement("p");
  summary.className = "summary";
  summary.textContent = request.summary || "(no details)";

  const actions = document.createElement("div");
  actions.className = "actions";
  for (const decision of decisions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = decision.id === "reject" ? "danger" : decision.id === "always" ? "quiet" : "primary";
    button.textContent = decision.label;
    button.disabled = state.busy.has(request.id);
    button.addEventListener("click", () => choose(request, decision.id));
    actions.append(button);
  }

  item.append(head, title, summary, actions);
  item.setAttribute("aria-busy", state.busy.has(request.id) ? "true" : "false");
  return item;
}

function relativeTime(value) {
  if (!value) return "";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

function choose(request, decision) {
  if (decision === "always") {
    state.alwaysRequest = request;
    els.always.showModal();
    return;
  }
  reply(request, decision);
}

async function reply(request, decision) {
  if (state.busy.has(request.id)) return;
  state.busy.add(request.id);
  updateCardBusy(request.id);
  try {
    await api("/api/reply", {
      method: "POST",
      body: JSON.stringify({ id: request.id, decision }),
    });
    state.requests = state.requests.filter((item) => item.id !== request.id);
    setStatus("Answered.");
    render();
  } catch (error) {
    if (error.status === 401) {
      await handleUnauthorized();
    } else if (error.status === 404 || error.status === 409) {
      state.requests = state.requests.filter((item) => item.id !== request.id);
      notice("Already answered or expired.");
      render();
    } else if (error.status === 502) {
      notice("Could not reach that OpenCode server. The request is still here.");
    } else {
      notice("Could not send that answer. Try again.");
    }
  } finally {
    state.busy.delete(request.id);
    updateCardBusy(request.id);
  }
}

function updateCardBusy(id) {
  const card = els.pending.querySelector(`[data-request-id="${CSS.escape(id)}"]`);
  if (!card) return;
  const busy = state.busy.has(id);
  card.setAttribute("aria-busy", busy ? "true" : "false");
  for (const button of card.querySelectorAll("button")) button.disabled = busy;
}

async function handleUnauthorized() {
  await clearSession();
  state.session = null;
  state.requests = [];
  state.servers = [];
  render();
  renderSession();
  setPairError("This device was disconnected. Pair again.");
  setStatus("Device disconnected.");
}

async function loadPending() {
  if (!state.session || document.hidden) return;
  clearTimeout(state.timer);
  setStatus("Refreshing.");
  try {
    const result = await api("/api/pending");
    state.requests = Array.isArray(result.requests) ? result.requests : [];
    state.servers = Array.isArray(result.servers) ? result.servers : [];
    state.fetchedAt = result.fetchedAt ?? null;
    render();
    setStatus(`${state.requests.length} waiting.`);
    state.timer = setTimeout(loadPending, POLL_MS);
  } catch (error) {
    if (error.status === 401) {
      await handleUnauthorized();
      return;
    }
    if (error.status === 502) notice("Server offline. Showing the last known requests.");
    else notice("Could not reach Pocket Approve.");
    setStatus("Offline.");
    state.timer = setTimeout(loadPending, ERROR_POLL_MS);
  }
}

function applyDeepLink() {
  if (state.deepLinkHandled) return;
  const params = new URLSearchParams(location.search);
  const id = params.get("request");
  if (id) {
    state.focusId = id;
    const card = els.pending.querySelector(`[data-request-id="${CSS.escape(id)}"]`);
    if (!card) {
      notice("Already answered or expired.");
      state.deepLinkHandled = true;
      history.replaceState(null, "", location.pathname);
      return;
    }
    const heading = card.querySelector("h3");
    heading?.focus();
    card.scrollIntoView({ block: "center" });
    state.deepLinkHandled = true;
    history.replaceState(null, "", location.pathname);
  }
  const error = params.get("error");
  if (error === "auth") handleUnauthorized();
  else if (error === "offline") notice("Could not reach the server. The request is still waiting.");
  else if (error === "answered") notice("Already answered or expired.");
}

function pushAvailable() {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  if (isIos() && !isStandalone()) return false;
  return true;
}

async function setupWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    state.registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    state.registration.addEventListener("updatefound", () => {
      const worker = state.registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) els.update.hidden = false;
      });
    });
    if (state.registration.waiting && navigator.serviceWorker.controller) els.update.hidden = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!state.reloading) {
        state.reloading = true;
        location.reload();
      }
    });
    return state.registration;
  } catch {
    return null;
  }
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function currentKey() {
  const result = await api("/api/vapid-public-key");
  return { ...result, bytes: base64UrlToBytes(result.publicKey) };
}

async function refreshVapidFingerprint() {
  if (!pushAvailable()) return;
  const key = await currentKey();
  if (state.session.pushFingerprint && state.session.pushFingerprint !== key.fingerprint) {
    els.pushStatus.textContent = "Notifications were set up for a different key. Enable them again.";
    const registration = state.registration ?? await setupWorker();
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  }
}

async function refreshSubscription() {
  if (!pushAvailable()) return;
  const registration = state.registration ?? await setupWorker();
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    els.pushStatus.textContent = "Notifications are not enabled on this device.";
    return;
  }
  const key = await currentKey();
  const existing = subscription.options?.applicationServerKey;
  if (existing && bytesToBase64Url(existing) !== key.publicKey) {
    await subscription.unsubscribe();
    els.pushStatus.textContent = "Notifications were set up for a different key. Enable them again.";
    return;
  }
  await api("/api/subscribe", {
    method: "POST",
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
  if (state.session.pushFingerprint !== key.fingerprint || state.session.pushOrigin !== location.origin) {
    state.session = { ...state.session, pushFingerprint: key.fingerprint, pushOrigin: location.origin };
    await writeSession(state.session);
  }
  els.pushStatus.textContent = "Notifications are on for this device.";
}

async function enableNotifications() {
  if (!pushAvailable()) {
    els.pushStatus.textContent = isIos() && !isStandalone()
      ? "Add Pocket Approve to your Home Screen first."
      : "This browser does not support notifications.";
    return;
  }
  els.enable.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      els.pushStatus.textContent = permission === "denied"
        ? "Notifications are blocked. Enable them in Settings."
        : "Notifications were not enabled.";
      return;
    }
    const registration = state.registration ?? await setupWorker();
    const key = await currentKey();
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key.bytes,
      });
    }
    await api("/api/subscribe", {
      method: "POST",
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
    state.session = { ...state.session, pushFingerprint: key.fingerprint, pushOrigin: location.origin };
    await writeSession(state.session);
    els.pushStatus.textContent = "Notifications are on for this device.";
    setStatus("Notifications enabled.");
  } catch {
    els.pushStatus.textContent = "Notifications could not be enabled. Try again.";
  } finally {
    els.enable.disabled = false;
  }
}

async function sendTest() {
  els.test.disabled = true;
  try {
    const result = await api("/api/test-notification", { method: "POST", body: "{}" });
    if (result.sent > 0) els.pushStatus.textContent = "Test sent.";
    else if (result.failed > 0) els.pushStatus.textContent = "Test failed. Check notifications for this app.";
    else els.pushStatus.textContent = "No subscription is registered for this device.";
  } catch {
    els.pushStatus.textContent = "Test notification failed.";
  } finally {
    els.test.disabled = false;
  }
}

async function unpair() {
  els.unpair.disabled = true;
  try {
    const registration = state.registration ?? await setupWorker();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      await api("/api/unsubscribe", {
        method: "POST",
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }).catch(() => {});
      await subscription.unsubscribe().catch(() => {});
    }
  } finally {
    await clearSession();
    state.session = null;
    state.requests = [];
    state.servers = [];
    render();
    renderSession();
    els.settings.close();
    els.pushStatus.textContent = "";
    els.unpair.disabled = false;
  }
}

function wireEvents() {
  els.pairForm?.addEventListener("submit", pair);
  els.settingsButton?.addEventListener("click", () => els.settings.showModal());
  els.closeSettings?.addEventListener("click", () => els.settings.close());
  els.enable?.addEventListener("click", enableNotifications);
  els.test?.addEventListener("click", sendTest);
  els.unpair?.addEventListener("click", unpair);
  els.alwaysCancel?.addEventListener("click", () => els.always.close());
  els.alwaysConfirm?.addEventListener("click", async () => {
    const request = state.alwaysRequest;
    els.always.close();
    if (request) await reply(request, "always");
  });
  els.updateButton?.addEventListener("click", () => {
    state.registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(state.timer);
      state.timer = null;
      setStatus("Paused.");
    } else {
      state.registration?.update().catch(() => {});
      loadPending();
    }
  });
  window.addEventListener("online", loadPending);
  window.addEventListener("offline", () => {
    setStatus("Offline.");
    notice("Your phone is offline. Showing the last known requests.");
  });
}

boot().catch((error) => {
  console.error(error);
  setPairError("Pocket Approve could not start. Reload the page.");
});
