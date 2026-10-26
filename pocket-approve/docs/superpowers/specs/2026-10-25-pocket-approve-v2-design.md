# Pocket Approve v2 Design

Date: 2026-10-25
Status: Draft for review
Repo: `<workspace>/pocket-approve`
Baseline: `bf914af Merge Pocket Approve v1`

## 1. Summary

Pocket Approve v1 answers OpenCode permission requests from a phone. It works, but it assumes one OpenCode server, one global token, and a local certificate authority that every phone must install and trust.

v2 removes those assumptions. It adds explicit multiple servers, a trusted HTTPS front door with no default CA install, per-device pairing, and a mobile-first approval flow that respects what iOS and Android actually support.

The design keeps the useful parts of v1: the small Node service, the vanilla PWA, server-side push, desktop notifications, and the terminal as the final fallback.

The recommended v2 topology is:

```
phone or desktop browser
        |
        | trusted HTTPS, stable origin
        v
Cloudflare Tunnel, Tailscale Serve, Caddy, or legacy LAN TLS
        |
        | loopback HTTP
        v
Pocket Approve sidecar 127.0.0.1:8080
        |
        | one client per configured server
        v
OpenCode server A, B, ... on loopback or private addresses
```

No CA is created in the default install. No setup HTTP listener is exposed to the LAN in proxy mode. OpenCode stays off the public internet. The sidecar owns device tokens, push subscriptions, and the merged approval queue.

## 2. Why v2

v1 is merged and green: 66 tests pass on Node 24.21.0. The remaining v1 gap is the real-device checklist, not code coverage. Three product problems are now clear.

1. One sidecar watches one OpenCode URL. A second TUI session can use a different embedded server, so requests appear to vanish. The live machine had servers on ports 4096, 4097, and 4098 with different bind addresses and auth states. v1 only watched `127.0.0.1:4096`.
2. Onboarding depends on a local CA. That is acceptable for the owner's own phone, not for other people. The CA private key is also a large blast radius for a small approval app.
3. The mobile path has four P0 defects: the iOS enable button appears where push cannot work, an installed app with no token is a dead end, origin or VAPID changes silently break push, and notification actions do not match platform limits.

v2 fixes these as one coherent release. It does not add discovery, remote shell access, or a multi-tenant service.

## 3. Goals and non-goals

### Goals

- Support 1 to 20 explicitly configured OpenCode servers.
- Route every reply to exactly one server. Never broadcast, never fall back to another server.
- Keep one unreachable or misconfigured server from blocking the others.
- Default to a trusted public or tailnet HTTPS origin with no manual CA install.
- Pair each phone or browser with a short code and a device token.
- Let the owner list and revoke devices. Revocation removes that device's push subscriptions.
- Make the installed PWA the primary approval surface on iOS and Android.
- Make notifications doorbells, not approval surfaces. Deny and Review are the only shade actions.
- Preserve desktop notifications and the terminal prompt.
- Keep the deployment small: Node, no build step, no database, no framework.
- Keep the existing 66 tests green and add coverage for the new boundaries.

### Non-goals for v2.0

- mDNS, Bonjour, or automatic server discovery. Discovery is unauthenticated and ambiguous. Explicit configuration wins.
- A remote shell, arbitrary command execution, or a proxy to OpenCode's full API. The phone gets an approval API, not a tunnel.
- Owner and guest origins in one install. One public origin per sidecar. Split-origin support is deferred to v2.1.
- A hosted multi-tenant service. Each user runs their own sidecar.
- A native iOS or Android app.
- Biometric approval, per-request step-up auth, or a phone-side hardware key.
- Hot reload of server configuration. Restart the sidecar after config changes in v2.0.
- Changing OpenCode. Pocket Approve uses the documented permission endpoints only.

## 4. Verified v1 baseline

These facts were read from the current tree. They are the contract the v2 work must not break by accident.

### Server and configuration

- `server.mjs:47` requires `config.host`, and `server.mjs:49` always calls `readTls(DATA_DIR)`. There is no non-TLS mode.
- `server.mjs:65` creates one HTTPS server on `httpsPort`; `server.mjs:66` creates one HTTP setup server on `setupPort`; both listen on `config.host` (`server.mjs:68`, `server.mjs:70`).
- `server.mjs:79` creates one poller. `server.mjs:84` sends desktop actions through `app.state.reply`.
- `lib/config.mjs:13-19` defaults: `host:null`, `httpsPort:8443`, `setupPort:8081`, `token:null`, `opencodeUrl:"http://127.0.0.1:4096"`, `opencodePassword:null`, `vapid:null`.
- `lib/config.mjs:52` rejects wildcard hosts. Config is written mode 0600; the data directory is 0700.
- `lib/opencode.mjs:29` lists through `GET /permission`. `lib/opencode.mjs:32-35` replies through `POST /permission/{id}/reply` with `{reply:decision}`. This is the current route, not the deprecated session route.
- `lib/adapters/opencode.mjs:5-16` keeps `id`, `sessionID`, `permission`, `patterns`, and `metadata`, and drops `always` and `tool`.
- `lib/state.mjs:54-70` deletes a pending item before the upstream reply, restores it on failure, and closes the desktop notification on success.
- `lib/poller.mjs:66` awaits `onNew` sequentially. `lib/poller.mjs:85` polls on a fixed interval. A failed poll leaves the known set intact.

### HTTP and auth

- `lib/app.mjs:133` takes the one global token from config. `lib/app.mjs:173` makes `/api/health` public. `lib/app.mjs:182` gates every other API on the bearer token.
- Routes: `/api/pending` (`lib/app.mjs:187`), `/api/reply` (`lib/app.mjs:204`), `/api/vapid-public-key` (`lib/app.mjs:247`), `/api/subscribe` (`lib/app.mjs:256`), `/api/test-notification` (`lib/app.mjs:286`).
- Unknown `/api/*` returns 404 (`lib/app.mjs:322`). The setup page gets a CSP (`lib/app.mjs:356`); the app page does not. There is no HSTS.
- `lib/auth.mjs:27-29` compares one raw expected token with a SHA-256 timing-safe compare. There is no device identity.
- `lib/push.mjs:256` sends with VAPID details only. Subscriptions are stored by endpoint, with no owner, TTL, urgency, or topic.

### Setup

- `scripts/setup.mjs:222` generates a 24-byte hex global token. `scripts/setup.mjs:231-239` creates a local CA and a server certificate. `scripts/setup.mjs:261` prints `https://host:8443/#token=...`; `scripts/setup.mjs:262` prints `http://host:8081/` for CA install.
- The certificate SAN is `IP:<host>,DNS:localhost,IP:127.0.0.1` (`scripts/setup.mjs:148`). The CA is valid for 3650 days; the server certificate for 825 days.

### PWA

- `public/app.js:60-67` accepts a token only from `#token=`. `public/app.js:124-149` stores it in localStorage and IndexedDB, preferring localStorage on read. `public/app.js:491-498` stops at a dead end when no token exists.
- `public/app.js:169` polls every 4 seconds, 8 seconds after an error. `public/app.js:482-487` refreshes on visibility but does not pause hidden polling.
- `public/app.js:311` considers push supported when `Notification`, `serviceWorker`, and `PushManager` exist. That is true in an iOS Safari tab, where push cannot work.
- `public/app.js:376-426` requests permission and subscribes without checking standalone mode or comparing the existing subscription's `applicationServerKey`.
- `public/sw.js:7-12` orders actions `once`, `reject`, `always`. `public/sw.js:115-118` slices to `Notification.maxActions`, with a fallback of 2, so Android drops Always and iOS shows none.
- `public/sw.js:80` treats a 404 reply as success. `public/sw.js:131-149` closes on success but leaves the notification in place on network failure. There is no `pushsubscriptionchange`.
- `public/manifest.webmanifest:10-17` declares only an SVG icon with `sizes:"any"`. `public/index.html:5` omits `viewport-fit=cover`; `public/index.html:12` uses an SVG apple-touch-icon.
- `public/style.css:40` uses `1.5rem 1rem 3rem` padding with no safe-area handling. `public/style.css:83` gives buttons a 2.9rem minimum height.

### Tests

`npm test` reports 66 tests, 66 pass, 0 fail. The baseline is a hard floor. A v2 change that lowers it is a regression unless the test itself encodes a v1 behavior that v2 deliberately replaces, and that replacement must be named in the change.

## 5. External facts and their status

The design depends on external APIs and platform behavior. The table separates what was verified locally from what still needs a real-device check.

| Claim | Status | Evidence or next check |
|---|---|---|
| OpenCode 1.19.0 lists pending permissions with `GET /permission`. | Verified against the installed OpenAPI document and runtime. | Captured in `/tmp/opencode/pocket-multiserver_full.md`. |
| OpenCode replies with `POST /permission/{requestID}/reply` and `{reply:"once"|"always"|"reject"}`. | Verified against the installed OpenAPI document. | Same report. The old session route is deprecated. |
| OpenCode Basic auth uses username `opencode` by default and `OPENCODE_SERVER_PASSWORD`. | Verified at runtime on a live server. | A 401 is an upstream failure, never a phone 401. |
| `always` is in-memory and server-local. It is not persisted across restart. | Verified at runtime; exact service-instance boundary is not fully documented. | Do not claim a precise session scope in UI copy. |
| iOS Web Push requires a Home Screen web app and a direct user gesture. | Vendor documented, not re-verified on a device in this repo. | Phase 0 device check on iOS 16.4 or newer. |
| Android Chromium exposes at most two notification actions. | Observed on the target desktop Chromium and consistent with platform behavior; phone check still required. | Plan for two actions, never three. |
| A stable HTTPS origin is required for service workers, push, and `crypto.subtle`. | Standard platform behavior. | Verified by the v1 LAN setup requiring TLS. |
| Cloudflare Tunnel can reach a loopback HTTP service with a trusted edge certificate. | Vendor documented, not re-verified in this repo. | Phase 3 runbook test. |
| Tailscale Serve can expose a loopback HTTP service on a trusted `*.ts.net` origin. | Vendor documented, not re-verified in this repo. | Phase 3 runbook test. |
| Access sessions survive in an installed iOS PWA and in background service worker fetches. | Unverified and risky. | Do not make Access the default gate for the API. Design assumes it may fail. |
| A VAPID key change invalidates existing push subscriptions. | Standard Web Push behavior. | Verify with a test subscription in Phase 4. |

Full research notes:

- `/tmp/opencode/pocket-multiserver_full.md`
- `/tmp/opencode/pocket-tls_full.md`
- `/tmp/opencode/pocket-mobile_full.md`

## 6. Decisions

### D1. Proxy mode is the default; LAN TLS is legacy

New installs use `mode:"proxy"`. The sidecar binds `127.0.0.1:8080` over plain HTTP. A trusted front door terminates TLS. `mode:"lan"` keeps the v1 HTTPS and setup servers for offline or isolated networks.

This separates two concerns that v1 mixed: transport trust and application auth. The front door solves origin trust. Device tokens solve authorization. OpenCode stays on loopback.

### D2. One stable origin per install

A push subscription belongs to an origin. Changing the origin invalidates every subscription. v2.0 supports one public origin per sidecar. If the front door changes, users re-pair and re-enable notifications.

This is a deliberate constraint. Supporting owner and guest origins in one process would double the auth, subscription, and audit models. Defer it.

### D3. Front door presets, chosen at setup

The setup tool offers four presets:

1. **Cloudflare Tunnel, token-only (recommended for most users).** A stable public hostname, trusted certificate, no CA, works anywhere, and works in an installed PWA. Device tokens are the only authorization. The app shell is public but useless without a token. Cloudflare sees request bodies after TLS termination, so command text is visible to the provider.
2. **Tailscale Serve (recommended when no public exposure is acceptable).** A stable `*.ts.net` origin on the tailnet. No public hostname, no CA, no third-party payload visibility. Every phone needs Tailscale and the VPN must be on for actions to reach the sidecar. The push itself still arrives when the VPN is off, but the action fails until the phone reconnects.
3. **Caddy with Let's Encrypt DNS-01 (LAN-only).** Trusted certificate without a public tunnel. Requires a domain, a DNS API token, and split DNS so the name resolves to the LAN address. Off-LAN use needs a VPN.
4. **Local CA (legacy).** The v1 path. Kept for offline or constrained networks. Never the default. Creates a CA, requires a profile on iOS and a user CA on Android, and keeps the HTTP setup listener.

Cloudflare Access is an optional outer gate, not the primary auth. Access sessions can expire and can behave differently in an installed PWA and in service worker fetches. If Access is used, gate only the human-facing pages and leave `/api/*` and `/sw.js` reachable, or accept that background actions may fail. The device token still protects every API call.

### D4. Device tokens replace the global token

A short pairing code creates a named device and a 256-bit device token. The server stores only the token hash. The phone stores the token in IndexedDB and sends it only in the `Authorization` header.

The v1 global token is accepted only in LAN mode when `allowLegacyToken` is true, so an existing LAN install can migrate without a flag day. It is never accepted in proxy mode, where the origin is public. New installs set it to false. v2.1 removes it.

### D5. Multiple servers are explicit, isolated, and namespaced

Each server has an id, label, URL, optional username, and a password source. Each server gets its own client, poller, cache, health record, and notification namespace. The merged queue is a read over those caches.

A reply names exactly one server. There is no broadcast and no fallback. A stale cache is better than a wrong approval.

### D6. Notifications are doorbells

The shade is not a trusted approval surface. On Android the only actions are Deny and Review. On iOS there are no actions. Tapping the body or Review opens the app on the exact request. Full approval controls live in the app, where the command text, server label, and consequences are visible.

This removes the current race where Android shows Allow once and Deny but drops Allow always, and where iOS shows a notification with no actions at all.

### D7. No discovery in v2.0

mDNS and similar discovery mechanisms are unauthenticated, bind broadly by default, and cannot establish identity. A wrong server is an approval sent to the wrong place. Configuration is explicit. A future discovery helper may propose URLs, but it must not become the trust path.

### D8. The sidecar owns state; the phone owns a token

Devices, pairing codes, subscriptions, seen request ids, and audit records live on the sidecar. The phone holds one device token and one push subscription. There is no phone-side database of approvals and no cloud sync.

### D9. Desktop keeps full actions

The desktop notification is local and trusted. It keeps Allow once, Deny, and Allow always, with the server label in the title. The phone is the remote surface and gets the safer model.

## 7. Architecture

### 7.1 Process layout

```
Pocket Approve process
  config loader
  device store
  pairing store
  subscription store
  audit log
  admin Unix socket (data/admin.sock, mode 0600)
  HTTP server 127.0.0.1:8080
  fleet manager
    ServerLink "local"
      OpenCodeClient -> 127.0.0.1:4096
      OpenCodeSource
      Poller
      cache: Map<rawId, request>
      health
    ServerLink "work"
      OpenCodeClient -> 127.0.0.1:4097
      ...
  desktop notifier (gdbus)
  push sender (web-push)
```

The admin socket is not a TCP port. It is a Unix domain socket inside the 0700 data directory. The front door must only route to 8080. It must never expose the socket.

### 7.2 Request flow

1. Each poller calls its own `GET /permission` every `pollIntervalMs` (default 3000, jittered).
2. A successful poll replaces that server's cache with the returned pending set.
3. New ids are added to the seen store and announced once. Removed ids are dropped and any matching desktop notification is closed.
4. A failed poll leaves the cache and seen store intact, records health, and does not re-announce old requests.
5. The fleet manager exposes the union of caches with namespaced ids.
6. A reply parses the namespace, finds the server, and posts to that server only.
7. On success the request leaves the cache and the desktop notification closes.
8. On upstream 404 or 409 the cache entry is removed and the phone gets the same semantic result.
9. On a network error, timeout, 401, or 5xx the cache entry stays and the phone gets 502. The card remains answerable.

### 7.3 Namespacing

Public request id: `"<serverId>:<rawRequestId>"`.

Server ids match `[a-z0-9][a-z0-9_-]{0,31}` and cannot contain a colon. The parser splits on the first colon. Raw OpenCode ids are used only inside the server link and are never accepted from the phone without a valid prefix.

This prevents two servers that both return `per_abc` from colliding in the queue, the desktop notifier, or a notification tag.

## 8. Configuration

### 8.1 Proxy mode

```json
{
  "mode": "proxy",
  "host": "127.0.0.1",
  "httpPort": 8080,
  "publicOrigin": "https://approve.example.com",
  "trustProxy": true,
  "allowInsecureUpstream": false,
  "pollIntervalMs": 3000,
  "allowLegacyToken": false,
  "servers": [
    {
      "id": "local",
      "label": "This laptop",
      "url": "http://127.0.0.1:4096",
      "username": "opencode",
      "passwordEnv": "OPENCODE_LOCAL_PASSWORD",
      "directory": null,
      "enabled": true
    },
    {
      "id": "work",
      "label": "Work box",
      "url": "http://127.0.0.1:4097",
      "username": "opencode",
      "passwordEnv": "OPENCODE_WORK_PASSWORD",
      "enabled": true
    }
  ],
  "vapid": {
    "subject": "mailto:owner@example.com",
    "publicKey": "...",
    "privateKey": "..."
  }
}
```

Rules:

- `mode` is `"proxy"` or `"lan"`. New installs default to proxy.
- In proxy mode `host` must be a loopback address. Binding `0.0.0.0`, `::`, or a LAN address is rejected.
- `httpPort` defaults to 8080 and must be 1 to 65535.
- `publicOrigin` is required in proxy mode, must be `https`, must be an origin only, and must not end in a slash. It is the only source of absolute URLs. The `Host` header is not trusted.
- `trustProxy` defaults to true in proxy mode. Forwarded headers are read only when the socket peer is loopback. They are used for logs and rate-limit hints, never for authorization.
- `allowInsecureUpstream` defaults to false. A server URL may use plain `http` only when the host is loopback. A non-loopback `http` URL is rejected unless this flag is true, and then `doctor` warns on every run. Basic auth over plain HTTP is cleartext. Prefer loopback, TLS, or an SSH tunnel.
- `pollIntervalMs` is 2000 to 10000, default 3000 with plus or minus 15 percent jitter per poll.
- `allowLegacyToken` is false for fresh v2 installs and true only for migrated v1 installs. It is honored only in LAN mode.
- `servers` has 1 to 20 entries. Empty or disabled-only fleets fail startup.
- `id` is required, unique, lowercase, and matches the namespace rule.
- `label` is 1 to 32 visible characters. It decorates notifications and cards.
- `url` is an `http` or `https` origin with no credentials, path, query, or fragment. HTTPS is allowed anywhere. HTTP is allowed only for loopback unless `allowInsecureUpstream` is true. A path is rejected because the OpenCode API lives at the origin root.
- `username` defaults to `opencode`.
- `passwordEnv` and `password` are mutually exclusive. `passwordEnv` is preferred. `password` exists only for legacy configs. The resolved password is never written to logs, the phone, or `/api/servers`.
- `directory` is optional. It is passed as a header or query only if the installed OpenCode API supports it; the v2.0 client leaves it null. Do not invent a parameter.
- `enabled` defaults to true. A disabled server has no poller and no cache.

### 8.2 LAN mode

```json
{
  "mode": "lan",
  "host": "192.168.100.2",
  "httpsPort": 8443,
  "setupPort": 8081,
  "servers": [ ... ],
  "vapid": { ... },
  "allowLegacyToken": true
}
```

LAN mode keeps the v1 transport: HTTPS on `httpsPort`, an HTTP CA setup page on `setupPort`, and a local CA. It still uses v2 device pairing and multi-server. The setup listener exists only to serve the CA and must not expose app APIs. This mode is documented as legacy and is never selected by default.

### 8.3 Migration and validation

- If `servers` is absent and `opencodeUrl` exists, create one server with `id:"default"`, `label:"OpenCode"`, `url:opencodeUrl`, `username:"opencode"`, and `password:opencodePassword` if present. Then remove the legacy fields from the saved file.
- If `servers` exists, ignore `opencodeUrl` and `opencodePassword`. There is no silent merge.
- A v1 config with a LAN host and existing certificates migrates to `mode:"lan"` first. Moving to proxy is a separate setup step so the owner can verify the front door before losing the old path.
- Validation fails fast with a path-specific message. The process does not start with a partially valid fleet.
- Server URLs are configuration, not phone input. They are still validated to prevent an accidental credential in a URL or a redirect to an unexpected host.
- A malformed server entry fails startup with a path-specific error. A missing `passwordEnv` value is different: that server starts with `config_error` health, no poller, and no cache, while the rest of the fleet continues. `doctor` names the missing variable.
- `redirect:"error"` on every upstream fetch. No redirect following.
- Upstream request timeout is 5000 ms. Reply timeout is 5000 ms. A timed-out poll is a health failure; a timed-out reply returns 502 and keeps the card.

### 8.4 Setup CLI

`npm run setup` supports an interactive path and repeatable flags:

```text
npm run setup -- --mode proxy --public-origin https://approve.example.com \
  --server local=http://127.0.0.1:4096 \
  --server work=http://127.0.0.1:4097
```

- `--mode proxy|lan`
- `--public-origin <url>`
- `--server <id>=<url>` repeated
- `--server-label <id>=<label>` repeated
- `--no-qr`
- `--force` to rewrite an existing config after printing a backup path

The setup tool:

- generates VAPID keys once and preserves them on re-run;
- generates a `pairingSecret` once and preserves it;
- writes `data/meta.json` with the VAPID fingerprint and schema version;
- creates no CA in proxy mode;
- does not print a global token;
- prints the public URL, the local admin command, and a one-time pairing code only if the sidecar is running and can service the admin socket;
- prints a QR code for the pair URL when `qrcode-terminal` is available.

### 8.5 Admin commands

The admin surface is a Unix socket, not a port:

```text
npm run pair [-- --label "Ada's iPhone"]
npm run devices
npm run revoke -- dev_abc123
npm run doctor
```

- `pair` asks the running sidecar for a code, prints `https://origin/pair#code=XXXX-XXXX`, the expiry, and a QR code.
- `devices` lists id, name, created, last seen, revoked, and subscription count. It never prints a token or hash.
- `revoke` marks the device revoked, deletes its subscriptions immediately, and writes an audit record.
- `doctor` checks config validity, each server's health, the VAPID fingerprint, the public origin, the legacy token setting, and the number of subscriptions. It redacts all secrets.
- If the sidecar is not running, `pair` fails with a clear message. It does not write a code that no process can consume.

## 9. Data stores

All files live under `data/` with directory mode 0700 and file mode 0600.

| File | Contents | Notes |
|---|---|---|
| `config.json` | Mode, ports, origin, servers, VAPID, pairing secret | Secrets stay here, never in the repo. |
| `meta.json` | Schema version, VAPID fingerprint, install time | Used to detect key rotation. |
| `devices.json` | Device records | Token hashes only. |
| `pairing.json` | At most one active code | Hash, salt, expiry, attempts, label. |
| `subscriptions.json` | Push subscriptions with `deviceId` | Endpoint, keys, timestamps, failure count. |
| `seen.json` | Recently announced request ids | Pruned after 7 days, or 1 hour after an id leaves every cache. |
| `audit.jsonl` | Append-only audit events | No bodies, no tokens, no passwords. |
| `admin.sock` | Local admin socket | Mode 0600, removed on clean shutdown. |

### Device record

```json
{
  "id": "dev_7f3c2a",
  "name": "Ada's iPhone",
  "tokenHash": "sha256:...",
  "tokenPrefix": "pk_7f3c",
  "createdAt": "2026-10-25T12:00:00.000Z",
  "lastSeenAt": "2026-10-25T12:00:00.000Z",
  "revokedAt": null,
  "scopes": ["read", "approve"]
}
```

- The token is 32 random bytes, base64url encoded. It is shown once.
- `tokenHash` is SHA-256 over the token. A 256-bit random token does not need a slow KDF.
- `tokenPrefix` is for display only. It is not a secret.
- `lastSeenAt` is updated at most once per minute per device to avoid constant writes.
- `scopes` are fixed to read and approve in v2.0. The field exists so a read-only device can be added later without a schema break.

### Pairing record

```json
{
  "hash": "hmac-sha256:...",
  "salt": "base64url...",
  "createdAt": "2026-10-25T12:00:00.000Z",
  "expiresAt": "2026-10-25T12:10:00.000Z",
  "attempts": 0,
  "label": "Ada's iPhone"
}
```

- Code alphabet: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (32 characters, no ambiguous 0/O/1/I).
- Eight characters, displayed as `XXXX-XXXX`, 40 bits of entropy.
- TTL 10 minutes. Single use. Five failed attempts invalidate the code.
- `hash = HMAC-SHA256(pairingSecret, salt || normalizedCode)`. Constant-time compare.
- A new code replaces the old one. At most one active code exists.
- Pair endpoint rate limit: 10 attempts per minute globally, plus the per-code five-attempt limit. Behind a proxy, per-IP limits are advisory because the socket peer is loopback.

### Subscription record

```json
{
  "endpoint": "https://...",
  "deviceId": "dev_7f3c2a",
  "keys": { "p256dh": "...", "auth": "..." },
  "createdAt": "2026-10-25T12:00:00.000Z",
  "lastSuccessAt": null,
  "lastFailureAt": null,
  "failures": 0
}
```

- Endpoint is the key. Re-posting the same endpoint updates the owner and keys.
- A subscription without a device is a legacy v1 record. It is kept for migration and pruned after the legacy token is disabled.
- 404 and 410 remove the subscription. 401 and 403 keep it and raise a health warning. 429 and 5xx keep it and count a failure.
- Revoking a device removes all matching subscriptions in one write.

### Audit record

```json
{"at":"2026-10-25T12:00:00.000Z","deviceId":"dev_7f3c2a","action":"reply","requestId":"local:per_abc","serverId":"local","result":"ok"}
```

Allowed actions: `pair`, `pair_failed`, `revoke`, `reply`, `subscribe`, `unsubscribe`, `test_notification`, `auth_failed`, `legacy_auth`, `config_warning`.

Never log: tokens, token hashes, pairing codes, passwords, full metadata, or command text. `requestId` and `serverId` are enough to investigate. Audit write failures are logged to stderr and do not block an approval.

## 10. HTTP API

All JSON responses use `application/json; charset=utf-8`. The body limit is 16 KB for API requests. Unknown methods return 405 with `Allow`. Unknown paths return 404.

Rate limits are per device unless stated otherwise: 120 requests per minute for reads, 30 per minute for replies, 10 per minute for subscribe, unsubscribe, and test notifications, and 10 per minute globally for pairing. Limits are in memory and reset on restart. A limit rejection returns 429 with `Retry-After`.

### Authentication

- `Authorization: Bearer <deviceToken>` on every API except `GET /api/health` and `POST /api/pair`.
- The server hashes the presented token and looks up an active device. Revoked or unknown tokens get 401 with `WWW-Authenticate: Bearer`.
- 401 means the device token is bad. It never means the upstream OpenCode password is bad.
- A state-changing request with an `Origin` header must match `publicOrigin`. In LAN mode, the expected origin is `https://<host>:<httpsPort>`. Mismatch gets 403.
- No CORS headers. The app is same-origin.
- `Cache-Control: no-store` on all API responses.

### `GET /api/health`

Public. No secrets.

```json
{ "ok": true, "version": "2.0.0", "mode": "proxy", "time": "2026-10-25T12:00:00.000Z" }
```

### `POST /api/pair`

Public, rate limited.

Request:

```json
{ "code": "K7QM-2F9D", "deviceName": "Ada's iPhone" }
```

Response 201:

```json
{
  "device": { "id": "dev_7f3c2a", "name": "Ada's iPhone" },
  "token": "base64url...",
  "origin": "https://approve.example.com"
}
```

Errors: 400 invalid body or name, 401 wrong or expired code, 410 expired code, 429 rate limited. Pairing requests are serialized. The server creates the device first, then consumes the code. If the device write fails, the code remains valid. The token is returned once and never stored in plaintext.

### `GET /api/me`

Returns the current device without secrets.

```json
{
  "device": {
    "id": "dev_7f3c2a",
    "name": "Ada's iPhone",
    "createdAt": "...",
    "lastSeenAt": "...",
    "scopes": ["read", "approve"]
  }
}
```

### `GET /api/pending`

Returns the merged cache. It does not fan out to servers on the request path.

```json
{
  "requests": [
    {
      "id": "local:per_abc",
      "serverId": "local",
      "serverLabel": "This laptop",
      "sessionID": "ses_...",
      "permission": "bash",
      "patterns": ["npm test"],
      "always": ["npm test"],
      "tool": "bash",
      "metadata": { "command": "npm test" },
      "title": "Bash: npm test",
      "summary": "npm test",
      "firstSeen": "2026-10-25T12:00:00.000Z"
    }
  ],
  "servers": [
    {
      "id": "local",
      "label": "This laptop",
      "ok": true,
      "pending": 1,
      "lastSuccess": "2026-10-25T12:00:01.000Z",
      "lastError": null,
      "latencyMs": 12
    }
  ],
  "fetchedAt": "2026-10-25T12:00:02.000Z"
}
```

- `requests` is sorted by `firstSeen` descending, then `id` ascending for a stable order.
- `servers` includes disabled servers only if they were configured at startup; disabled means `ok:false`, `lastError:"disabled"`.
- No server URL, username, password, or token appears in this response.
- `always` and `tool` are preserved from the adapter for display and for the Always explanation. They are not sent back in a reply.

### `GET /api/servers`

Same `servers` array as above. Useful for a settings or health screen. No secrets.

### `POST /api/reply`

Request:

```json
{ "id": "local:per_abc", "decision": "once" }
```

`decision` is `once`, `always`, or `reject`.

Responses:

- 200 `{ "ok": true, "id": "...", "decision": "once" }`
- 400 invalid body or decision
- 401 bad device token
- 404 unknown request id or upstream 404
- 409 upstream says already answered
- 502 server offline, timeout, upstream 401, or upstream 5xx

On 404 from upstream, remove the cache entry and close the desktop notification. On 502, keep both. The phone keeps the card and shows the error. Do not optimistically remove a card before the sidecar confirms.

### `GET /api/vapid-public-key`

```json
{ "publicKey": "base64url...", "fingerprint": "sha256:...", "origin": "https://approve.example.com" }
```

The client compares `fingerprint` with the one stored beside its subscription. A mismatch triggers unsubscribe and resubscribe.

### `POST /api/subscribe`

Request:

```json
{
  "subscription": {
    "endpoint": "https://...",
    "expirationTime": null,
    "keys": { "p256dh": "...", "auth": "..." }
  }
}
```

- Requires a device token.
- Validates the endpoint is HTTPS, `p256dh` and `auth` are present, and the JSON is under the body limit.
- Associates the endpoint with the calling device.
- Returns `{ "ok": true, "subscriptions": 1 }`.
- Re-posting the same endpoint is idempotent.

### `POST /api/unsubscribe`

```json
{ "endpoint": "https://..." }
```

Removes the endpoint only if it belongs to the calling device. Returns 204.

### `POST /api/test-notification`

Sends only to the calling device's subscriptions. Payload id is `test:<uuid>` and is not a real request.

```json
{ "sent": 1, "failed": 0, "pruned": 0 }
```

A test push does not deep-link to a request. Its `kind` is `test`, so the service worker opens the app root and shows a short "Test notification" notice. It never sends a reply.

### Static routes

- `/` and `/pair` serve the app shell.
- `/app.js`, `/style.css`, `/sw.js`, `/manifest.webmanifest`, `/icon-192.png`, `/icon-512.png`, `/icon-maskable-512.png`, `/apple-touch-icon.png`.
- `/sw.js` is served with `Cache-Control: no-cache`, `Service-Worker-Allowed: /`.
- HTML is served with `Cache-Control: no-store`.
- Icons may be cached for a day.
- No directory listing, no source maps in production, no dotfiles.

### Security headers

The app and API responses send:

```text
Content-Security-Policy: default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
```

- HSTS is sent in proxy mode when `publicOrigin` is HTTPS, and in LAN mode over HTTPS. Do not add `includeSubDomains` or `preload`.
- The setup page keeps its own stricter CSP and is never served in proxy mode.
- No inline event handlers or inline scripts. The app loads `/app.js` as a module.
- The service worker is same-origin and scoped to `/`.

## 11. Pairing and device auth

### Pairing flow

1. The owner runs `npm run pair -- --label "Ada's iPhone"` on the computer.
2. The sidecar creates a code, stores its HMAC, and returns the pair URL.
3. The owner sends the URL or QR code to the phone. The code is in the fragment, so it is not sent to the server on page load or written to front-door logs.
4. On iOS, the pair page first checks whether the app is installed. Web Push only works in a Home Screen web app. The page shows Share > Add to Home Screen instructions and does not offer an enable button in a Safari tab.
5. The phone opens `/pair`, reads the fragment, clears it with `history.replaceState`, asks for a device name, and posts the code to `/api/pair`.
6. The server validates the origin, rate limit, code hash, expiry, and attempt count. It creates the device, consumes the code, writes the audit record, and returns the token once.
7. The phone stores `{token, origin, deviceId, deviceName, pairedAt}` in IndexedDB, never localStorage. It uses the token only in the `Authorization` header.
8. The phone calls `/api/me` and `/api/pending`. If the token is rejected, it clears local state and shows the pair screen.

### Device auth rules

- A device token is an approval authority. Treat it like a password.
- The token is never placed in a URL after pairing, a log, a notification, or an API response except the one-time pair response.
- The service worker reads the token from the same IndexedDB database. It does not duplicate it in a cache or a query string.
- On 401, the app clears the token, origin, and device id, unsubscribes the local push subscription if possible, and shows "This device was disconnected. Pair again."
- A token is scoped to one origin by storage. The app compares the stored origin with `location.origin` on boot. A mismatch means re-pair, not a silent send to the new origin.
- Revocation is immediate on the server. Existing in-flight replies may still complete; that race is accepted and audited.

### Why not a bearer token in the URL

A URL token leaks through history, screenshots, front-door logs, and shared links. The fragment is better than a query string, but it is still a one-time bootstrap secret. Pairing converts it into a stored device token and removes it from the address bar immediately.

### Legacy token migration

- A migrated v1 config sets `allowLegacyToken:true`. The flag is honored only in LAN mode.
- In LAN mode, the legacy token is accepted for `GET /api/pending`, `GET /api/servers`, `POST /api/reply`, `GET /api/vapid-public-key`, and `POST /api/test-notification`.
- It is not accepted for pairing, device management, subscribe, or unsubscribe.
- Existing v1 subscriptions are kept with `deviceId:null` and continue to receive pushes on the same LAN origin until the device is paired or the token is disabled. Moving to proxy mode changes the origin, so those subscriptions are stale and are cleared.
- A legacy test notification goes to all unowned subscriptions, because there is no device to scope it to.
- Every legacy request writes a `legacy_auth` audit record and a startup warning.
- `doctor` reports the legacy token state. The migration checklist turns it off after the first device is verified.
- v2.1 removes the legacy path and prunes unowned subscriptions.

## 12. Multi-server fleet

### ServerLink lifecycle

Each `ServerLink` owns:

- immutable config for one server;
- one `OpenCodeClient` with its own auth header and timeout;
- one `OpenCodeSource`;
- one `Poller`;
- `cache: Map<rawId, request>`;
- `health: {ok, lastSuccess, lastError, latencyMs, consecutiveFailures}`;
- a generation number used to ignore late results after a restart or config reload.

Startup:

1. Validate the full fleet before opening the HTTP listener.
2. Create a link per enabled server.
3. Start all pollers. One failure does not abort the others.
4. Start the HTTP server and admin socket.
5. Log a one-line health summary with ids and labels only.

Shutdown:

1. Stop accepting new HTTP requests.
2. Stop pollers and wait for in-flight polls with a 5 second cap.
3. Close desktop notifications.
4. Remove the admin socket.
5. Close stores.

### Cache semantics

- A successful poll replaces the cache. Requests no longer returned are gone.
- A failed poll keeps the cache. Health records the failure.
- A request that disappears from one server does not affect another.
- Cache entries carry `firstSeen`. A server that flaps does not reset the age.
- The cache is bounded to 500 pending per server and 2000 total. Beyond that, drop the oldest and log a warning. Approval is not a bulk queue.

### Reply routing

- Parse `id` at the first colon. Reject if the prefix is missing or unknown with 404.
- Look up the raw id only in that server's cache. Do not search other servers.
- Send the reply to that server's client.
- Map upstream responses:
  - 200 or 204: success, remove cache, close desktop.
  - 404: remove cache, close desktop, return 404.
  - 409: remove cache, close desktop, return 409.
  - 401: keep cache, mark `auth_failed`, return 502 `server_unauthorized`.
  - 5xx, timeout, network: keep cache, return 502 `server_unavailable`.
- Never retry a reply automatically. A retry can double-approve. The phone may retry explicitly.

### Health

`health.lastError` is a stable code, not a raw upstream body: `offline`, `timeout`, `unauthorized`, `http_500`, `invalid_response`, `config_error`, `disabled`.

The UI shows:

- green: at least one recent success;
- amber: last poll failed but cache is non-empty, "Showing last known requests";
- red: no successful poll since startup.

No server URL or credential is shown to the phone by default. A local `doctor` command can show the URL.

### Polling

- Default 3000 ms with jitter.
- One in-flight poll per server.
- Immediate first poll.
- No overlapping polls.
- Failed polls back off: 3s, 6s, 12s, capped at 30s, reset on success.
- Polling continues while the process runs. The phone's visibility does not control server polling; push latency depends on it.
- The phone polls `/api/pending` every 10 seconds while visible, pauses when hidden, and refreshes immediately on visibility. Push is the primary signal.

## 13. Notification path

### New request

1. Poller returns a request not in `seen`.
2. Add `serverId:rawId` to `seen` with a timestamp.
3. Build a desktop notification with title `[Label] Title` and the namespaced id.
4. For each subscription owned by an active device, send one push.
5. If there are more than 10 new requests in one poll, send one digest instead of 10 pushes. The digest says "10 new requests" and deep-links to the inbox. Individual requests appear in the app.
6. Persist `seen` after the notifications are attempted. A failed send does not cause an infinite re-notify loop. Health records the failure.

### Payload

```json
{
  "id": "local:per_abc",
  "serverId": "local",
  "serverLabel": "This laptop",
  "title": "Bash: npm test",
  "summary": "npm test",
  "count": 2,
  "kind": "request"
}
```

Rules:

- `title` is capped at 64 characters.
- `summary` is capped at 140 characters.
- `serverLabel` is capped at 32 characters.
- `count` is the total pending count across the fleet. It drives the badge and the digest.
- The serialized payload must be under 3.5 KB. If it is larger, truncate title and summary further; never send the full command.
- The full command stays in `/api/pending` and is rendered as text in the app.
- Test payloads use `kind:"test"` and `id:"test:<uuid>"`.

### Web Push options

```js
{
  TTL: 600,
  urgency: "high",
  topic: base64url(sha256(id)).slice(0, 32)
}
```

- TTL 600 seconds. A stale approval is worse than no notification.
- `topic` is per request, URL-safe, at most 32 characters. It lets the push service replace a duplicate for the same request without collapsing different requests.
- Do not use `topic` for the digest; use a short-lived random topic.
- iOS ignores `tag` and actions. Do not depend on either.

### Android notification

- Actions: `Deny` (action `reject`) and `Review` (action `review`). At most two.
- No Allow action in the shade. Approval needs the app.
- Tap on the body opens `/?request=<encoded id>`.
- `tag` is the namespaced request id.
- `renotify:false`, `requireInteraction:false`, `silent:false`.
- `data.url` is the relative deep link.

### iOS notification

- No actions.
- Tap opens `/?request=<encoded id>`.
- The service worker does not assume `Notification.maxActions` exists.
- The app must be a Home Screen web app. A Safari tab shows install instructions instead of an enable button.

### Notification click behavior

- No action: close and open the deep link.
- `review`: close and open the deep link.
- `reject`: read token, POST `/api/reply` with `reject`.
  - Success: close the notification. The app badge updates on next open.
  - 401: clear local auth, open `/?request=<id>&error=auth`.
  - 404 or 409: close and open `/?request=<id>&error=answered`.
  - Network or 502: open `/?request=<id>&error=offline`; do not leave a dead notification.
- If there is no token, open `/pair?request=<id>` and do not POST.
- If the request is missing from the app, show "Already answered or expired" and keep the inbox usable.

### Badge

- On app load and after a successful poll, call `navigator.setAppBadge(count)` when available.
- On zero, call `navigator.clearAppBadge()`.
- On iOS Home Screen, this is supported on recent versions. On Android it is inconsistent. Guard every call. The badge is a convenience, not correctness.
- The push payload includes `count` so a future service worker badge path can use it.

### Desktop

- Keep the three local actions: Allow once, Deny, Allow always.
- Title: `[Server Label] <tool>: <pattern>`.
- Body: summary, capped at 140.
- Namespaced id maps to the DBus notification id.
- On success, close. On upstream failure, leave the desktop notification and log.
- `always` copy: "Allow always asks OpenCode to remember this permission for this server. OpenCode controls the exact scope." Do not claim a precise session boundary.

## 14. PWA and mobile UX

### First run on iOS

1. Open the pair URL in Safari.
2. The page detects iOS and non-standalone mode.
3. It shows: "On iPhone, notifications work after you add Pocket Approve to the Home Screen." with Share > Add to Home Screen steps.
4. The user may continue in the browser for approval only, but the enable button stays hidden. The page says push is unavailable in this tab.
5. After installing, open the Home Screen app. If the token is not present (iOS storage isolation), pair inside the installed app with a fresh code.
6. The installed app shows Enable notifications. The button is the direct gesture that requests permission.
7. If permission is denied, show "Notifications are off. Open Settings > Notifications > Pocket Approve." Do not leave a disabled dead button.

### First run on Android

1. Open the pair URL in Chrome.
2. Pair, store the token, and show Enable notifications.
3. Push works in the tab and after install. Installation is recommended for the launcher icon and badge, not required for push.
4. If `beforeinstallprompt` is available, show an Install action. Otherwise show browser menu instructions.

### Inbox

```
Pocket Approve                        2 pending
This laptop  online   Work box  offline

[This laptop]  Bash: npm test
npm test
[Allow once] [Deny] [Allow always]

[Work box]  Edit: src/server.ts
src/server.ts
[Allow once] [Deny] [Allow always]
```

- One card per pending request.
- Server label chip on every card.
- Offline servers show an amber banner and keep their last known requests.
- A card that was answered elsewhere disappears on the next poll.
- Empty state distinguishes "No pending requests" from "All servers offline".
- Relative time plus an absolute time in the accessible label.
- The command text is rendered with `textContent`, never `innerHTML`.
- `Always` opens a confirmation sheet: "Allow always for this server? OpenCode may apply it to matching requests until it restarts. It is not saved when OpenCode restarts." Buttons: Cancel, Allow always.
- Buttons are disabled while a reply is in flight. A failed reply re-enables them and shows the server's error.
- The card has `aria-busy` during a reply.

### Deep link

- `/?request=local%3Aper_abc` focuses and scrolls to that card.
- The heading gets `tabindex="-1"` and focus after render.
- If the id is gone, show "Already answered or expired." Do not shift focus to a random card.
- If the deep link arrives before the first poll, store it and apply it after render.
- The URL is cleaned with `history.replaceState` after focus so a refresh does not re-trigger the animation.

### Notification settings

- Status: unsupported, install required, permission denied, not subscribed, subscribed, test failed.
- Enable notifications asks for permission only from the click.
- After permission, subscribe with the VAPID key from `/api/vapid-public-key`.
- Compare the existing subscription's `options.applicationServerKey` with the current key. If different, unsubscribe and resubscribe.
- Store the VAPID fingerprint next to the subscription record. If it changes on boot, unsubscribe and resubscribe.
- Re-post the current subscription on every app start. This recovers a server data wipe without user action.
- `pushsubscriptionchange` best effort: resubscribe with the current key and POST the new subscription. If it fails, set a flag and retry on next app open.
- Send test shows `sent`, `failed`, and `pruned` counts. A test never claims success when zero sends happened.
- Unsubscribe removes the server record for this device.

### Service worker

- Install: do not call `skipWaiting()` automatically.
- The app checks `registration.waiting` on load and shows "Update ready. Reload." A message triggers `SKIP_WAITING`; `controllerchange` reloads once.
- Activate: `clients.claim()`.
- `/sw.js` is served no-cache.
- The worker reads the token from IndexedDB on every action. It does not keep a module-level token.
- All fetches use `credentials:"same-origin"` and `cache:"no-store"` for APIs.
- No API response is cached.
- `push` and `notificationclick` are the only required handlers. `pushsubscriptionchange` is best effort.

### Polling and visibility

- App poll: 10 seconds while visible.
- Pause when `document.visibilityState === "hidden"`.
- Immediate refresh on visible.
- After a successful reply, refresh immediately.
- After a 401, stop polling and show the pair screen.
- After a 502, back off to 20 seconds for that cycle.

### Manifest and icons

- `name: "Pocket Approve"`, `short_name: "Approve"`.
- `id: "/"`, `start_url: "/"`, `scope: "/"`.
- `display: "standalone"`, `display_override: ["window-controls-overlay", "standalone"]` only if tested; otherwise standalone.
- Icons: 192x192 PNG, 512x512 PNG, 512x512 maskable PNG with all meaningful content inside the central 80 percent safe zone, 180x180 apple-touch PNG.
- `purpose` values: `any` for 192 and 512, `maskable` for the maskable file.
- `theme_color: "#111111"`, `background_color: "#f5f5f2"`.
- `launch_handler` and `shortcuts` are P2. Add only if tested.
- Keep the SVG as a browser favicon, not as the only install icon.

### Accessibility

- `viewport-fit=cover` and safe-area padding on `main`, header, and bottom actions.
- Minimum 44x44 CSS pixel targets.
- Visible `:focus-visible` outline on buttons, links, and cards.
- Status and notice use `role="status"` with `aria-live="polite"`. Errors that interrupt use `role="alert"`.
- Deep-linked card focus is visible.
- Color contrast meets WCAG AA in light and dark themes.
- `prefers-reduced-motion` disables the highlight animation.
- The command text is selectable and wraps with `overflow-wrap:anywhere`.
- Buttons have explicit labels. Icon-only buttons are avoided.
- The notification settings state is text, not color alone.

### Error copy

- No token: "Pair this device to start. Ask for a code on the computer."
- Bad or expired code: "That code is wrong or expired. Ask for a new code."
- Revoked token: "This device was disconnected. Pair again."
- Origin mismatch: "This app was paired with a different address. Pair again at the new address."
- Upstream auth failure: "Pocket Approve cannot sign in to this OpenCode server. Check its password on the computer."
- Server offline: "This server is offline. Showing its last known requests."
- Push denied: "Notifications are off. Open Settings > Notifications > Pocket Approve."
- iOS tab: "On iPhone, add Pocket Approve to the Home Screen to enable notifications."
- VAPID mismatch: "Notifications need to be set up again on this device."
- Already answered: "This request was already answered or expired."

## 15. Front-door runbooks

### 15.1 Cloudflare Tunnel, token-only

Use this when the phone must work outside the LAN and the owner has a domain on Cloudflare. This is the default recommendation for an installed PWA.

1. Install `cloudflared` on the computer.
2. `cloudflared tunnel login`.
3. `cloudflared tunnel create pocket-approve`.
4. Create `~/.cloudflared/config.yml`:

```yaml
tunnel: pocket-approve
credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: approve.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

5. `cloudflared tunnel route dns pocket-approve approve.example.com`.
6. Start the sidecar on `127.0.0.1:8080`.
7. `cloudflared tunnel run pocket-approve`.
8. Verify `https://approve.example.com/api/health` from the phone.
9. Pair a device. Confirm the token works and the CA is absent.

Do not add Access to `/api/*` or `/sw.js`. If Access is added to the human-facing pages, test an installed iOS app and a background Deny action before relying on it. The device token is the security boundary, not Access.

### 15.2 Cloudflare Tunnel with Access, optional

Use only when browser-tab use is acceptable or when the installed-app behavior has been verified.

- Create a self-hosted Access application for the hostname.
- Policy: allow the owner's email or identity provider group.
- Session duration: the longest available, up to one month.
- Bypass `/api/*`, `/sw.js`, `/manifest.webmanifest`, and the icon paths so background actions are not redirected to a login page.
- Accept that command text passes through Cloudflare after TLS termination.
- Test session expiry and background actions before shipping.

### 15.3 Tailscale Serve

Use this when no public exposure is acceptable and every phone can run Tailscale.

1. Install Tailscale on the computer and each phone. Put them in the same tailnet.
2. Start the sidecar on `127.0.0.1:8080`.
3. `tailscale serve --bg 8080` or the equivalent HTTPS serve command for the installed version.
4. Use the printed `https://<machine>.<tailnet>.ts.net` origin as `publicOrigin`.
5. Restrict access with tailnet ACLs to the owner and the phone devices.
6. Verify from a phone with the VPN on.
7. Confirm behavior with the VPN off: the push arrives, the action opens the app, the fetch fails with the offline message, and the card remains.

No CA, no public hostname, no third-party payload visibility. The tradeoff is the VPN requirement.

### 15.4 Caddy with DNS-01

Use this for a LAN-only install with a trusted certificate.

1. Install Caddy with the DNS provider module.
2. Point a DNS name at the LAN address with split DNS. Do not publish a public A record to a private address unless DNS rebinding behavior is understood and accepted.
3. Configure Caddy:

```text
approve.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

4. Use the DNS-01 challenge so no inbound port 80 is required.
5. Set `publicOrigin` to the HTTPS name.
6. Verify from the phone on the LAN and over the VPN.

### 15.5 Local CA, legacy

Only for offline or constrained networks.

- `npm run setup -- --mode lan --host <lan-ip>`.
- The setup page serves the CA certificate. iOS requires a profile install and full trust. Android requires a user CA and shows a warning.
- The CA private key is on the computer. Treat it as a high-value secret.
- Pairing still uses device tokens. The global legacy token is optional and should be disabled after migration.
- Delete `ca.key`, `ca.crt`, `server.key`, and `server.crt` after the install moves to a trusted front door. Keep a backup until the new path is verified.

## 16. Threat model

### Assets

- The authority to approve a command on an OpenCode server.
- Command text, paths, and session metadata.
- OpenCode server passwords.
- Device tokens and push subscriptions.
- The VAPID private key and the pairing secret.
- The audit trail.

### Adversaries and controls

| Threat | Control |
|---|---|
| Network attacker on the LAN | No plaintext HTTP to phones. Proxy mode uses a trusted front door. LAN mode uses TLS. Sidecar binds loopback in proxy mode. |
| Unauthenticated internet visitor | Every API except health and pair requires a 256-bit device token. Static shell contains no data. |
| Stolen phone with unlocked app | Device token is usable until revoked. v2.0 has no biometric step-up. Owner can revoke from the computer. Accepted residual risk. |
| Stolen phone, locked | OS lock protects the app. Notification content may show command text on the lock screen. Accepted residual risk; payload text is capped. |
| Malicious website | No CORS. Bearer token is not sent cross-site. Origin check on state changes. CSP blocks injected scripts. Frame ancestors none. |
| XSS through command text | Render with `textContent`. No `innerHTML` for request data. Strict CSP. |
| CSRF | Bearer header plus Origin check. No cookie auth. |
| Pairing brute force | 40-bit code, 10 minute TTL, single use, five attempts, global rate limit, HMAC at rest. |
| Pairing code leak | Short TTL and single use. Code is in a fragment, not a query. Front-door logs do not see it. |
| Token at rest on the server | Only SHA-256 hashes. File mode 0600, directory 0700. |
| Token in logs | Authorization headers are never logged. URL tokens are not used after pairing. |
| Password leak | Passwords come from env or config, are redacted in doctor output, and never enter API responses or logs. |
| Upstream credential sniffing | Non-loopback HTTP is rejected by default. Basic auth over plain HTTP is cleartext on the wire. Use loopback, HTTPS, or an SSH tunnel. |
| Wrong-server approval | Namespaced ids, strict routing, no broadcast, no fallback. |
| Server impersonation | Server URLs are local config. Upstream TLS is verified when https. No redirects. |
| Front-door provider sees payload | Cloudflare terminates TLS and can see command text. Documented. Tailscale Serve avoids this. |
| Front-door account compromise | Device token still required. Access is defense in depth, not the only gate. |
| Push service sees payload | Web Push encrypts the payload to the user agent. The provider sees metadata, not plaintext. The device OS can display the notification. |
| Push subscription theft | Endpoint alone cannot approve; the device token is separate. A stolen endpoint can receive notifications. Revoke the device and delete its subscriptions. |
| Replay of a reply | Replies are idempotent at the OpenCode layer only as far as upstream allows. Pocket Approve does not auto-retry. A replayed request id after it leaves the cache returns 404. |
| `always` is broader than expected | UI copy says OpenCode controls the scope and it is not persisted. Keep Always out of the notification shade. |
| Malicious local process | It can read the config and admin socket if it runs as the same user. That is equivalent to local shell access. Do not run the sidecar as root. |
| Disk full | Approval still works if audit writes fail. Token or device writes fail closed with 500. |

### Accepted risks

- Command text appears on the lock screen. This is inherent to a notification that is useful without opening the app.
- Cloudflare sees request bodies in the token-only preset.
- An unlocked phone with the app open can approve. v2.0 does not add a second factor.
- `always` can cover more than the visible request. The UI warns; the exact OpenCode boundary is not documented precisely enough to promise more.
- A local process running as the same user can read secrets. This is outside the app boundary.

## 17. Failure behavior

| Condition | Server behavior | Phone behavior |
|---|---|---|
| One server offline | Keep its cache, health amber, other servers continue | Offline banner, last known cards remain |
| One server 401 | Keep cache, health `unauthorized`, reply 502 | "Check its password on the computer" |
| One server returns malformed JSON | Treat as failed poll, keep cache | Same as offline |
| One server times out | 5s timeout, back off, keep cache | Same as offline |
| Reply returns upstream 404 | Remove cache, close desktop, return 404 | Remove card, notice "Already answered or expired" |
| Reply returns upstream 409 | Remove cache, close desktop, return 409 | Remove card, same notice |
| Reply network failure | Keep cache, return 502 | Keep card, show retry |
| Device token rejected | 401 | Clear local token, show pair screen |
| Device revoked | 401 on next request | Clear local token, show pair screen |
| Pair code expired | 410 | "That code is wrong or expired" |
| Pair code reused | 401 | "That code is wrong or expired" |
| Push endpoint 404/410 | Remove subscription | Test reports pruned; next app open re-subscribes |
| Push 401/403 | Keep subscription, health warning | Test reports failed; settings shows "Notifications need setup again" |
| VAPID rotated | Subscription fingerprint mismatch; do not send to stale records | App compares fingerprint, unsubscribes, resubscribes |
| Origin changed | Device token from the old origin is not present in the new origin | Pair screen on the new origin |
| Front door down | Phone cannot reach the API | App shell may not load; no approval path except desktop or terminal |
| Service worker stale | Served no-cache, update prompt on app load | "Update ready. Reload." |
| Notification action network fail | No server state change | Open app with `error=offline`, keep card |
| No token in service worker | No reply attempt | Open pair screen with the request id |
| Disk write failure for audit | Log to stderr, continue | No visible change |
| Disk write failure for device pair | Return 500, do not consume the code twice | "Could not pair. Try again." |
| Config invalid | Fail startup with a path-specific error | App cannot load; doctor explains |
| Corrupt devices file | Fail closed, no auth, log and require restore | 401 or unavailable; doctor explains |
| Corrupt subscriptions file | Skip bad records, keep valid ones | Some devices need to re-enable |

## 18. Migration from v1

### Before upgrading

1. Back up `data/` and the v1 config.
2. Record the current origin and the fact that every push subscription is tied to it.
3. Confirm the current OpenCode URL and password source.
4. Confirm the phone can still approve on v1.

### Upgrade path

1. Install v2. Start once in `mode:"lan"` with the migrated `servers[0]`. Verify the queue and one reply.
2. Run `npm run doctor`. It reports the legacy token, the server health, and the VAPID fingerprint.
3. Choose a front door. Run `npm run setup -- --mode proxy --public-origin ...`. Keep the old LAN config as a backup file.
4. Start the sidecar on `127.0.0.1:8080`. Verify `/api/health` through the front door.
5. Create a pairing code with `npm run pair`. Pair the phone on the new origin.
6. Install the PWA on iOS before pairing inside the installed app. On Android, pair in the browser or installed app.
7. Enable notifications and send a test. Confirm the test arrives.
8. Approve a real request from the phone. Confirm the desktop notification closes and the terminal prompt resolves.
9. Enable a second server and confirm a request from each server routes correctly, including identical raw ids.
10. Before leaving LAN mode, set `allowLegacyToken:false` and restart. In proxy mode the legacy token is rejected regardless. Confirm the old token gets 401.
11. Run `npm run devices` and remove any test devices.
12. After one week of stable proxy use, delete the CA files and the v1 setup listener config.

### Origin and VAPID changes

- A new origin means new storage. Pair again. Old push subscriptions cannot be migrated.
- A new VAPID key means every subscription is invalid. The server detects the fingerprint change at startup, clears subscriptions, and logs a warning. Every device re-enables notifications.
- Keeping the same origin and VAPID across upgrades preserves subscriptions.

### Rollback

- Keep the v1 config and `data/` backup until the proxy path is verified.
- v1 ignores v2 device files and still uses the legacy token. Rolling back to v1 works only in LAN mode.
- Rolling back after the CA is deleted requires regenerating the CA and reinstalling it on every phone.

## 19. Testing

### Unit tests

- Config: defaults, proxy vs LAN validation, wildcard rejection, URL origin validation, non-loopback HTTP rejection, duplicate ids, 20-server cap, password source exclusivity, legacy migration, explicit servers win over legacy fields.
- Auth: token hash, unknown token, revoked token, scope check, legacy token path, origin mismatch.
- Pairing: code format, HMAC compare, expiry, single use, attempt lock, rate limit, device creation before code consumption, failed device write leaves code valid.
- Devices: revoke removes subscriptions, lastSeen throttle, no token in list output.
- Fleet: namespace parse, unknown prefix, colliding raw ids, cache merge, cache replacement, offline cache retention, reply routing, upstream 404/409/401/5xx mapping, timeout.
- Adapter: preserves `always` and `tool`, caps title and summary, handles missing fields.
- Push: payload size, title and summary caps, topic length and alphabet, TTL and urgency options, 404/410 prune, 401/403 keep, per-device filter, revocation cleanup.
- Seen store: prune, restart persistence, no duplicate announce, failed send does not loop.
- Admin: socket permissions, pair response, revoke, doctor redaction.
- Static: security headers, CSP, no-cache on sw and HTML, path traversal, HEAD, method allowlist.

### Integration tests

- Two fake OpenCode servers return the same raw request id. The merged queue has two namespaced ids. Replying to one calls only that server.
- One fake server is offline. `/api/pending` returns 200 with the other server's requests and an amber health entry. No 502 for the union.
- One fake server returns 401. Reply returns 502 with `server_unauthorized`, the card stays, and the phone token is still valid.
- A reply to an unknown id returns 404 without touching any server.
- Pairing creates a device; a second use of the same code fails; an expired code fails; five wrong attempts lock the code.
- Revoking a device invalidates its token and removes its subscriptions in one operation.
- In LAN mode, a legacy v1 token can read and reply but cannot subscribe. `allowLegacyToken:false` makes it 401. In proxy mode it is always 401.
- A config reload requires a restart and does not leave an old poller running.
- A failed push send is counted and does not re-announce on the next poll.
- A 404 push endpoint is pruned; a 403 endpoint is kept.

### Real-device matrix

At minimum:

- iPhone, iOS 16.4 or newer, Safari tab: install gate appears, no enable button, no false success.
- iPhone, Home Screen app: pair inside the app, enable, receive push, tap deep link, Deny action, offline action.
- Android, Chrome tab: pair, enable, receive push, Deny and Review actions, body tap.
- Android, installed PWA: same, plus launcher icon and badge if supported.
- Desktop browser: pair from the URL, approve, see the desktop notification close.
- Revoked device: next request gets 401 and the pair screen.
- Origin change: old token does not leak to the new origin; pair screen appears.
- VAPID change: app detects the fingerprint change and resubscribes.
- Front door: Cloudflare Tunnel, Tailscale Serve with VPN on and off, Caddy LAN, legacy CA.
- Pairing: expired code, reused code, wrong code five times, code entered on the wrong origin.

### Manual acceptance

- The 66 v1 tests still pass.
- `npm test` passes with the new tests.
- No test requires a real OpenCode server. Fake servers cover routing. One live two-server check is a release gate.
- `npm run doctor` exits 0 on a healthy install and never prints a secret.
- `npm run setup` in proxy mode creates no CA files.
- The app works with JavaScript modules and no build step.

## 20. Implementation phases

### Phase 0: Device truth and safety rails

- Verify iOS Home Screen storage isolation, push permission, and notification behavior on the target iOS version.
- Verify Android action limits and badge behavior.
- Confirm PNG icon rendering and maskable safe zone.
- Add the real-device checklist to the release gate.

Exit: the P0 assumptions are either confirmed or the UX copy and gates are adjusted.

### Phase 1: Config and fleet

- Add the config schema, validation, migration, and server list.
- Add `ServerLink`, per-server pollers, caches, health, namespacing, and strict reply routing.
- Preserve `always` and `tool`.
- Add fake two-server tests.
- Keep the v1 HTTP API shape behind a compatibility flag if needed.

Exit: multiple servers work behind the existing UI; one offline server does not block another; 66 baseline tests plus new fleet tests pass.

### Phase 2: Proxy mode and front door

- Split `server.mjs` into proxy and LAN branches.
- Add `httpPort`, `publicOrigin`, `trustProxy`, and the loopback-only listener.
- Remove CA generation from the proxy setup path.
- Add HSTS and the app CSP.
- Add Cloudflare Tunnel and Tailscale runbooks.
- Add `doctor`.

Exit: a phone reaches the sidecar through a trusted HTTPS origin with no CA; direct LAN access to the sidecar is closed; OpenCode remains loopback.

### Phase 3: Pairing and device auth

- Add the device store, pairing store, admin Unix socket, and commands.
- Add `POST /api/pair`, `/api/me`, and device auth.
- Add subscription ownership and revocation cleanup.
- Add the legacy token migration path.
- Add pair, revoke, and auth tests.

Exit: a new device pairs with a code, a revoked device gets 401, revocation removes its subscriptions, and the legacy token can be disabled.

### Phase 4: PWA P0 and P1

- Add the pair screen, install gate, and recovery flows.
- Replace the three-action shade with Deny and Review.
- Add deep links and focused cards.
- Add VAPID fingerprint checks, resubscribe, and `pushsubscriptionchange`.
- Add TTL, urgency, topic, payload caps, and digest behavior.
- Add PNG icons, manifest fields, safe-area layout, focus styles, and update prompt.
- Pause hidden polling and refresh on visibility.

Exit: the real-device matrix passes for iOS and Android, including a Deny action and a deep link.

### Phase 5: P2 and release

- Manifest polish, badge best effort, accessibility audit.
- Audit log rotation, rate limits, and body limits.
- Documentation rewrite, v1 corrections, and migration guide.
- Security review and a live two-server release check.
- Remove the v1 global token path in v2.1, not in v2.0.

Exit: the definition of done is met and the v1 manual checklist is either passed or explicitly retired with a replacement.

## 21. Definition of done

- Two OpenCode servers with colliding raw request ids appear as two distinct cards, and each reply reaches only its own server.
- One offline server shows an amber state, keeps its last known cards, and does not block the other servers.
- A fresh proxy install creates no CA and requires no certificate profile on the phone.
- The phone reaches the app through a trusted HTTPS origin on iOS and Android.
- Pairing with a code creates a named device; the token is stored in IndexedDB, not localStorage; the pair secret is cleared from the URL.
- Revoking a device invalidates its token and deletes its push subscriptions.
- The legacy token can be disabled without breaking a paired device.
- iOS Safari tab shows install instructions and no enable button.
- iOS Home Screen app can pair, enable push, receive a push, and open the exact request.
- Android notifications show at most Deny and Review, never Allow in the shade.
- Deep links focus the right card and handle an already-answered request.
- A push endpoint 404 is pruned; a 401/403 does not delete the subscription and is visible in test results.
- VAPID rotation and origin change both lead the user to a clear re-pair or re-enable path, never a silent failure.
- The app has no inline scripts, no `innerHTML` for request data, and a working CSP.
- The sidecar binds loopback in proxy mode and rejects wildcard hosts.
- `npm test` passes, including the original 66 tests and the new fleet, auth, pairing, and push tests.
- `npm run doctor` reports the fleet, origin, VAPID fingerprint, legacy token state, and device count without secrets.
- The docs are updated, including the v1 report correction: v1 uses `POST /permission/{id}/reply`, not the deprecated session route.
- The real-device matrix has a dated result, and the v1 manual checklist is closed or replaced.

## 22. Open questions for review

1. Default front door for this owner: Cloudflare Tunnel token-only, Tailscale Serve, or Caddy LAN? The spec recommends Cloudflare Tunnel for reachability and Tailscale for zero public exposure. The choice affects the setup wizard copy and the release test.
2. Does the owner have a domain on Cloudflare, or is a tailnet the better default?
3. Should the admin surface stay a Unix socket, or is a loopback TCP admin port easier to operate? The socket is smaller and avoids a new port, but it is less familiar.
4. Should the legacy token be enabled by default on migration, or should migration require an explicit `--allow-legacy-token` flag? The spec accepts it only in LAN mode and warns loudly.
5. Is one public origin enough for v2.0, or is there an immediate need for an owner Tailscale origin plus a guest Cloudflare origin? The spec defers the split to v2.1.
6. Should desktop keep Allow always after the phone loses it, or should both surfaces require a confirmation? The spec keeps desktop full and adds a confirmation sheet on the phone.
7. Is a 10-minute pairing code acceptable, or should it be 5 minutes? The spec uses 10 minutes to allow install-then-pair on iOS.

## 23. Sources

Local, verified in this tree:

- `server.mjs`, `lib/config.mjs`, `lib/opencode.mjs`, `lib/adapters/opencode.mjs`, `lib/state.mjs`, `lib/poller.mjs`, `lib/app.mjs`, `lib/auth.mjs`, `lib/push.mjs`, `lib/desktop.mjs`, `lib/summarize.mjs`.
- `public/app.js`, `public/sw.js`, `public/index.html`, `public/style.css`, `public/manifest.webmanifest`.
- `scripts/setup.mjs`, `test/*.test.mjs`.
- `npm test` on Node 24.21.0: 66 tests, 66 pass, 0 fail.
- Live v1 setup: LAN host `192.168.100.2`, ports 8443 and 8081, OpenCode on `127.0.0.1:4096`, local CA, one global token, one FCM subscription.

External, captured in research reports or platform documentation:

- OpenCode 1.19.0 OpenAPI document and runtime behavior, captured in `/tmp/opencode/pocket-multiserver_full.md`.
- Web Push, service worker, notification, badging, and PWA install behavior from vendor documentation, captured in `/tmp/opencode/pocket-mobile_full.md`.
- Cloudflare Tunnel, Cloudflare Access, Tailscale Serve, Caddy DNS-01, and local CA tradeoffs, captured in `/tmp/opencode/pocket-tls_full.md`.
- MDN Web Push API and Notification API documentation for standard behavior.
- Apple Safari Web Push documentation for iOS Home Screen requirements.
- Google Chrome notification action limits for Android.

Unverified assumptions are listed in section 5 and repeated at the point where they affect a decision. They must be closed by Phase 0 or by a front-door runbook test before the v2.0 release.
