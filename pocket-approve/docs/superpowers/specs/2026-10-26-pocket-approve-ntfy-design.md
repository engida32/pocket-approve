# Pocket Approve ntfy Transport Design

Date: 2026-10-26
Status: Approved for implementation
Repo: `/home/emmrc-02/personal-works/.worktrees/pocket-approve-v2/pocket-approve`
Baseline: `522a4dc` on `feat/pocket-approve-v2`

## 1. Summary

Pocket Approve currently delivers approvals through a browser PWA and Web Push. That path needs a trusted HTTPS origin, a service worker, OS notification permission, and on iOS a Home Screen web app. The self-signed CA and the stale VAPID keys are the source of the current real-device failures.

This design adds a second, browserless delivery path built on ntfy. The user runs `npm run connect`, scans one QR code with the Android ntfy app on first use, and receives each OpenCode permission request as a notification with Approve, Always, and Deny buttons. A button posts a signed reply to a random ntfy topic. The Node process reads that topic as an NDJSON stream and calls the existing fleet reply path. `npm run disconnect` stops the local service from another terminal. The phone keeps its subscription, so the next `npm run connect` needs no rescan. `npm run ntfy` remains an alias for `connect`.

The web path stays in the tree. `npm run phone` and the PWA are untouched. When ntfy is configured, phone delivery uses ntfy instead of Web Push. Desktop notifications continue in both modes, and are on by default when a desktop session is available.

## 2. Why ntfy

The browser constraint is structural, not a bug. `Notification.requestPermission()` needs a secure context and a user gesture. Service workers need a secure context. iOS Web Push needs a Home Screen web app. A QR code cannot grant OS notification permission by itself.

The research compared four options.

- **ntfy** is the only option that satisfies the literal Android requirement: scan a QR, the app subscribes, no account, no inbound server. It supports up to three action buttons and an `http` action on Android, Apple, and Firefox. Its weak points are that `ntfy://` auto-subscribe is Android only, public topics are effectively passwords, and public ntfy.sh sees message content.
- **Telegram** is the simplest cross-platform state machine. One bot, one deep link, one Start tap, inline buttons, long polling, no inbound URL. It requires a Telegram account and app, and approval content passes through Telegram.
- **Pushover** is notification only. It has supplementary URLs, not action buttons.
- **A native app** has the most control and the highest cost: Android project, FCM, signing, and iOS APNs.

The user chose ntfy, Android first, public ntfy.sh, and replacement of Web Push when ntfy is configured.

## 3. Goals and non-goals

### Goals

- Add a browserless entry point: `npm run connect`, with `npm run ntfy` as an alias.
- Add `npm run disconnect` to stop a running connection from another terminal without deleting the phone subscription.
- Pair an Android phone by scanning one QR code, with no account and no web form.
- Deliver each pending request as an actionable ntfy notification.
- Support Approve once, Always allow, and Deny.
- Route every reply through the existing `fleet.reply` path.
- Keep desktop notifications.
- Skip Web Push entirely when ntfy is configured.
- Persist settings so the QR is stable across restarts.
- Recover from transient publish and stream failures without losing approvals.
- Keep the implementation dependency free and testable.
- Leave `npm run phone`, the PWA, the CA flow, and the v1 compatibility files untouched.

### Non-goals

- Self-hosted ntfy.
- iOS QR auto-subscribe.
- A web approval page, local HTTP server, TLS, CA, service worker, or PWA for the ntfy path.
- Multi-user or multi-tenant operation. One owner per data directory.
- Multiple phones for one data directory.
- End-to-end encryption of approval content.
- Guaranteed delivery. ntfy.sh is a third party and its cache is finite.
- Revoking one phone without rotating the topics.
- Hot reload of the OpenCode server list.
- Changing OpenCode or its permission API.
- Running as a background daemon, systemd unit, or auto-start service. `connect` runs in the foreground; `disconnect` stops it from another terminal.
- Disconnecting the phone from the ntfy topic. `disconnect` stops the local Node process; the phone subscription remains until `--rotate` or manual removal in the app.
- Adding runtime dependencies.

## 4. Closed decisions

| Decision | Choice |
|---|---|
| Phone delivery | Replace Web Push when ntfy is configured |
| Desktop delivery | Keep |
| Notification detail | Summary plus command, path, description, and patterns, capped under the ntfy limit |
| ntfy server | Public `https://ntfy.sh` |
| Pairing | Android QR using `ntfy://`; iOS manual topic add |
| Runtime | Minimal ntfy runtime, no HTTP listener |
| Settings store | `data/ntfy.json`, mode 0600 |
| Lifecycle | `npm run connect` foreground; `npm run disconnect` via a pid file; `npm run ntfy` alias |
| Existing phone flow | Unchanged |
| Dependencies | None added |

## 5. Verified current behavior

These facts were read from `HEAD 522a4dc`.

- `lib/notifications.mjs` builds request and digest payloads, caps title at 64 and summary at 140, caps the Web Push body at 3584 bytes, marks requests seen through `seen.takeNew`, sends desktop notifications, and pushes to active devices.
- `createNotifications` currently requires `fleet`, `seen`, `push`, `devices`, and `desktop`.
- When more than 10 fresh requests arrive, `announce` sends one digest payload. A digest has no per-request approval actions.
- `lib/fleet.mjs` polls configured servers, namespaces request IDs as `serverId:rawId`, and exposes `pending()` and `reply(publicId, decision)`. `reply` validates the decision, rejects duplicates in flight, calls the source, and forgets the request on success.
- `lib/seen.mjs` `takeNew` marks requests as seen before the notification is sent. There is no release path.
- `lib/runtime.mjs` always composes devices, pairing, push, the PWA app, the admin socket, and TLS or proxy HTTP. It requires `config.pairingSecret`.
- `scripts/phone.mjs` discovers sessions, configures LAN TLS, starts the full runtime, and prints a CA QR and a pairing QR.
- `lib/config-v2.mjs` validates proxy and LAN modes. There is no notify mode.
- `package.json` has only `qrcode-terminal` and `web-push` as runtime dependencies.
- The live LAN service has one device, `dev_30555680`, with read and approve scopes. Its FCM subscription was created under different VAPID keys. `sendTest("dev_30555680")` returns `{sent:0,failed:1,pruned:0}` with the VAPID mismatch error.

## 6. External facts and their status

| Fact | Source | Status |
|---|---|---|
| ntfy supports up to three user actions per notification | `docs/publish.md`, Action buttons | Verified |
| ntfy action buttons are supported on Android, Apple, and Firefox | `docs/publish.md` | Verified |
| The `http` action sends a request when tapped, defaults to POST, and supports `url`, `method`, `headers`, `body`, and `clear` | `docs/publish.md`, Send HTTP request | Verified |
| `ntfy://<host>/<topic>` opens the Android app and subscribes if needed; `?display=` sets a name; `?secure=false` uses HTTP | `docs/subscribe/phone.md` | Verified |
| `ntfy://` deep linking is Android only | `docs/subscribe/phone.md` | Verified |
| The iOS app has no documented `ntfy://` URL scheme | iOS docs plus source inspection of `binwiederhier/ntfy-ios` | Verified absence; manual check still useful |
| Topic names allow letters, numbers, `_`, and `-`, up to 64 characters; the topic is effectively a password | `docs/publish.md`, topic names | Verified |
| `GET <topic>/json` returns newline-delimited JSON with `open`, `message`, and `keepalive` events | `docs/subscribe/api.md` | Verified |
| `?poll=1` reads cached messages and closes; `since=` accepts a duration, timestamp, message ID, `all`, or `latest` | `docs/subscribe/api.md` | Verified |
| Default `keepalive-interval` is 45 seconds | `docs/config.md` | Verified |
| Default message size limit is 4 KB; larger messages are not recommended and are limited by FCM and APNs | `docs/publish.md`, `docs/config.md` | Verified |
| Default visitor rate limit is a 60-request burst refilled at one request per 5 seconds | `docs/config.md` | Verified |
| ntfy caches messages server-side for 12 hours by default; `Cache: no` disables caching | `docs/publish.md`, Message caching | Verified |
| Priority `4` is high and `5` is max; tags such as `warning` are supported | `docs/publish.md` | Verified |
| `https://ntfy.sh` reports healthy | `/v1/health` | Verified on 2026-10-26 |

The following remain manual, real-device checks: Android action delivery under battery optimization, iOS action-button behavior, and whether the iOS app can import a topic from a QR code. The design does not assume the last one works.

## 7. Architecture

```
OpenCode servers
      |
      | poll /permission
      v
lib/fleet.mjs  --->  lib/notifications.mjs  --->  desktop
                              |
                              | ntfy publish
                              v
                        https://ntfy.sh/<outTopic>
                              |
                              | FCM or APNs
                              v
                        ntfy app on phone
                              |
                              | Approve / Always / Deny
                              | HTTP POST
                              v
                        https://ntfy.sh/<replyTopic>
                              |
                              | NDJSON stream
                              v
                        lib/ntfy.mjs
                              |
                              | verify HMAC
                              v
                        lib/fleet.mjs reply
                              |
                              v
                        OpenCode permission endpoint
```

There is no inbound listener. The phone talks only to ntfy.sh. The Node process makes outbound HTTPS requests only.

The `connect` process writes `data/ntfy.pid` with its PID and mode 0600. `npm run disconnect` reads that file, checks the process is still alive, sends SIGTERM, and waits up to five seconds. The running process handles SIGTERM exactly like Ctrl+C: it stops the fleet poller, aborts the reply stream, releases the PID file, and exits. A second `connect` refuses to start while the recorded PID is alive. A stale PID file is removed automatically. On Linux, `disconnect` also checks `/proc/<pid>/cmdline` for `scripts/ntfy.mjs` before signalling, to avoid hitting an unrelated process after PID reuse; other platforms fall back to `process.kill(pid, 0)`.

## 8. Components

### 8.1 `lib/ntfy.mjs`

Owns settings, notification construction, signing, publishing, reply streaming, and reconnection.

Exports:

- `ntfySettingsPath(dataDir)`: returns the `ntfy.json` path under `dataDir`.
- `newToken()`: returns 32 random bytes encoded as base64url, 43 characters.
- `normalizeSettings(raw)`: validates `baseUrl`, `outTopic`, `replyTopic`, `secret`, `lastEventId`, and `lastEventAt`.
- `createSettings(now?)`: generates random topics and a secret.
- `loadSettings(dataDir)`: reads `ntfy.json` and returns `null` when the file is missing. It does not create the file.
- `saveSettings(dataDir, settings)`: atomic write, mode 0600.
- `rotateSettings(settings, now?)`: replaces both topics and the secret and clears the cursor.
- `ntfyLink(settings, display)`: returns `ntfy://<host>/<outTopic>?display=<encoded>`.
- `signReply(secret, id, decision)`: HMAC-SHA256 over `id + "\n" + decision`, base64url.
- `verifyReply(secret, id, decision, sig)`: checks the signature with a timing-safe compare.
- `parseReply(settings, message)`: parses the body and returns `{id, decision}` or `null` when the JSON, id, decision, or signature is invalid.
- `buildRequestMessage(item, settings, {allowAlways, count})`: builds the title, message, detail, priority, tags, and actions.
- `buildTestMessage(settings, id)`: builds a test message with one Approve action.
- `fitMessage(message, maxBytes?)`: shrinks the detail until the serialized message is under the limit. It removes whole detail lines first, then truncates the longest remaining line when one line alone is too large.
- `createNtfy({settings, dataDir, audit, fleet, allowAlways, fetchImpl, log, sleep, now})`: returns `{settings, start, stop, publishRequest, publishNotice, sendTest, waitForTest}`.

`createNtfy` behavior:

- `publishRequest(item, {count})` builds, fits, and publishes the message. It retries three times with short backoff. It throws after the final failure.
- `publishNotice(text)` publishes the failure notice to the outbound topic with priority 4 and the tag `warning`.
- `sendTest()` publishes a test message with an Approve action whose ID starts with `test:`, then returns that ID.
- `waitForTest(id, timeoutMs)` waits for the reply carrying that test ID.
- `start(onReply)` opens `GET <baseUrl>/<replyTopic>/json`. It uses `since=<lastEventId>` when present, otherwise `since=10m`. It parses NDJSON, ignores `open` and `keepalive`, handles `message`, and reconnects with jittered exponential backoff.
- The stream has a watchdog. If no bytes arrive for 90 seconds, it aborts and reconnects. This is twice the default 45 second keepalive.
- `stop()` aborts the stream, cancels retries, and waits for the read loop to finish.
- Every processed message event advances `lastEventId` and `lastEventAt` in `ntfy.json`. Malformed events are logged and skipped, but the cursor still advances.

### 8.2 `lib/ntfy-runtime.mjs`

Composes only what the ntfy path needs:

- `createAudit`
- `createSeenStore`
- `createDesktop` when a desktop session is available
- `createFleet` with the server list and `pollIntervalMs`
- `createNtfy`
- `createNotifications` with `ntfy`, `desktop`, `audit`, `seen`, and `fleet`

It does not create devices, pairing, push, the PWA, the admin socket, TLS, or the CA.

Exports `createNtfyRuntime({config, settings, dataDir, desktop, log, fetchImpl})` returning `init`, `start`, `stop`, `fleet`, `notifications`, `ntfy`.

### 8.3 `scripts/ntfy.mjs` and `lib/ntfy-lifecycle.mjs`

`scripts/ntfy.mjs` is the CLI entry point for both `connect` and `disconnect`. `lib/ntfy-lifecycle.mjs` holds the PID-file helpers so they can be tested without spawning a process.

Arguments:

- `--disconnect`: stop the running connect process and exit. Used by `npm run disconnect`.
- `--no-qr`: print the link instead of a QR.
- `--rotate`: replace both topics and the secret, clear the cursor, save, and print a new QR.
- `--test`: publish a test notification after the reply stream is running.
- `--opencode <url>`: discovery origin, default `http://127.0.0.1:4096`.
- `--label <name>`: display name for the QR topic, default `Pocket Approve`, max 64.
- `--allow-always`: include Always allow. Enabled by default.
- `--no-always`: omit Always allow, leaving Approve once and Deny.
- `--show-topic`: print the outbound topic for manual iOS setup.
- `--help`.

Connect startup:

1. Parse arguments. If `--disconnect` is present, run the disconnect flow below and exit.
2. Load `data/config.json` with `loadConfigV2` if it exists. Use its servers.
3. If no config exists, discover sessions at the OpenCode origin with `discoverSessions`, derive directories with `directoriesFromSessions`, build servers with `serversForDirectories`, and add `enabled: true`, `username: "opencode"`, and `password: null`.
4. Refuse to start with zero servers.
5. Load or create `data/ntfy.json`.
6. Rotate settings when requested.
7. Acquire `data/ntfy.pid` with the current PID. If a live connect process already owns it, print its PID and `Run: npm run disconnect` and exit with status 1. If the recorded PID is dead, remove the stale file and continue.
8. Create the ntfy runtime.
9. `init` and `start`.
10. Print the server count, ntfy server, QR or link, Android instructions, and the iOS manual steps when `--show-topic` is used.
11. When `--test` is set, publish the test notification.
12. Print a warning not to run `npm run phone` at the same time.
13. Wait for SIGINT or SIGTERM. Stop the runtime, release the PID file, and exit cleanly. Release the PID file on startup failure too.

Disconnect flow:

1. Read `data/ntfy.pid`. If it does not exist, print `No ntfy connection is running.` and exit 0.
2. If the PID is not alive, remove the stale file and print `No ntfy connection is running.` and exit 0.
3. On Linux, read `/proc/<pid>/cmdline`. If it does not contain `scripts/ntfy.mjs`, treat the file as stale rather than signalling an unrelated process.
4. Send SIGTERM. Wait up to five seconds, checking every 100 ms.
5. If the process exits, print `Disconnected.` and exit 0.
6. If it is still alive, print that it did not stop and exit 1. Do not send SIGKILL.

The CLI never starts an HTTP server, never prints a CA URL, and never asks for a pairing code. The PID file is not an HTTP listener or a control socket; it only lets another local command find the process to stop.

### 8.4 `lib/notifications.mjs`

Changes:

- `createNotifications` accepts `ntfy` and `digest`.
- When `ntfy` is present, `push` and `devices` are optional. When `ntfy` is absent, the existing requirements remain.
- `announce` uses the ntfy path when `ntfy` is present:
  - Snapshot `fleet.pending()`.
  - Observe active IDs.
  - Filter to the current server.
  - Take up to 20 fresh requests. Leave overflow unseen for the next poll.
  - For each fresh request, send a desktop notification and an ntfy message. There is no digest.
  - Release the seen IDs for any request whose ntfy send fails after retries.
  - Return counts for desktop, ntfy, and pushes. `pushes` is zero in ntfy mode.
- `sendTest` publishes through ntfy when configured and never calls Web Push.
- The Web Push path remains exactly as it is today when `ntfy` is absent.

The ntfy message is built from the full fleet item. `requestPayload` stays unchanged for Web Push.

### 8.5 `lib/seen.mjs`

Add `release(ids)`. It removes the given IDs from the seen set and persists the store. `announce` calls it when every publish attempt for a request fails.

This keeps the existing lock behavior during a publish while allowing a later poll to retry a failed request.

### 8.6 `package.json`

Add:

```json
"connect": "node scripts/ntfy.mjs",
"disconnect": "node scripts/ntfy.mjs --disconnect",
"ntfy": "node scripts/ntfy.mjs"
```

`connect` is the documented entry point. `ntfy` stays as a short alias so the earlier plan still works. No dependency changes.

### 8.7 Files not changed

- `scripts/phone.mjs`
- `lib/runtime.mjs`
- `lib/config-v2.mjs`
- `lib/app-v2.mjs`
- `lib/push.mjs`
- `lib/desktop.mjs`
- `lib/fleet.mjs`
- `lib/app.mjs`
- `lib/config.mjs`
- `scripts/setup.mjs`

## 9. Settings and data model

`data/ntfy.json`, mode 0600:

```json
{
  "version": 1,
  "baseUrl": "https://ntfy.sh",
  "outTopic": "<43-char base64url>",
  "replyTopic": "<43-char base64url>",
  "secret": "<43-char base64url>",
  "createdAt": "2026-10-26T00:00:00.000Z",
  "lastEventId": null,
  "lastEventAt": null
}
```

Validation:

- `baseUrl` is an HTTPS origin only, with no credentials, path, query, or fragment.
- `outTopic` and `replyTopic` match `^[A-Za-z0-9_-]{1,64}$` and are different.
- `secret` is at least 32 characters.
- `lastEventId` is a string or null.
- `lastEventAt` is an ISO timestamp or null.

`data/ntfy.pid`, mode 0600, contains the decimal PID of the running connect process followed by a newline. It is created after settings load and before the runtime starts. It is removed on clean exit and on startup failure. It is not part of the settings JSON and never contains a topic or secret.

`data/seen.json` is unchanged. Audit entries use the existing `reply` and `test_notification` actions.

## 10. Pairing

Android:

1. Install the ntfy app from Google Play or F-Droid.
2. Run `npm run connect`.
3. Scan the QR with the phone camera.
4. The app opens the topic and subscribes.
5. Run `npm run connect -- --test` or tap the test notification to verify the reply path.

The QR contains:

```text
ntfy://ntfy.sh/<outTopic>?display=Pocket%20Approve
```

iOS:

1. Install ntfy from the App Store.
2. Run `npm run connect -- --show-topic`.
3. Add server `ntfy.sh` and the printed outbound topic manually.

The CLI must not claim that the iOS QR auto-subscribes.

The service cannot know whether the phone subscribed. The test notification is the confirmation. A test reply exercises the full path: publish, phone app, HTTP action, reply topic, stream, signature check, and acknowledgement.

Lifecycle after pairing:

- `npm run disconnect` stops the local connect process. The phone stays subscribed to the topic.
- The next `npm run connect` reuses the same `data/ntfy.json`, so there is no rescan and no new QR.
- Ctrl+C in the connect terminal has the same effect as `npm run disconnect`.
- Running `npm run connect` while another connect process is alive is refused with the existing PID and a `npm run disconnect` hint.

Rotation:

- `--rotate` generates new topics and a new secret, clears `lastEventId`, saves 0600, and prints a new QR.
- The old phone subscription stops receiving new requests.
- Rotation is the response to a lost phone or a leaked topic.

## 11. Request notification

Each message contains:

- Title: `[serverLabel] title`, capped at 64 characters. This uses the same idea as the desktop title so multiple servers are distinguishable.
- Message: the 140-character summary, then a blank line, then detail lines.
- Detail: command, path, description, tool, permission, session, and matched patterns. The serialized message is capped at 4000 bytes, leaving margin under the ntfy 4096-byte limit.
- Priority: `4` (high).
- Tags: `warning`.
- Actions: up to three `http` actions.

Default actions:

| Label | Decision |
|---|---|
| Allow once | `once` |
| Always allow | `always` |
| Deny | `reject` |

`--no-always` omits the middle action.

Action shape:

```json
{
  "action": "http",
  "label": "Allow once",
  "url": "https://ntfy.sh/<replyTopic>",
  "method": "POST",
  "headers": {
    "Content-Type": "application/json"
  },
  "body": "{\"id\":\"server:request\",\"decision\":\"once\",\"sig\":\"<base64url>\"}",
  "clear": true
}
```

The signature is HMAC-SHA256 over `id + "\n" + decision`, keyed by the local secret.

The full publish body is measured after serialization. If it exceeds the limit, detail lines are removed from the end in steps until it fits. If one line alone is still too large, that line is truncated. The summary and actions are never dropped.

## 12. Reply flow

1. The phone taps an action.
2. The ntfy app sends the HTTP request to the reply topic.
3. The Node process receives the message on the NDJSON stream.
4. It advances the cursor and deduplicates the message ID in memory.
5. `parseReply` parses the body, then `verifyReply(secret, id, decision, sig)` checks the HMAC in constant time.
6. Invalid signatures are logged and ignored.
7. A test ID (`test:`) is audited as `test_notification` and acknowledged. It never calls `fleet.reply`.
8. A normal ID calls `fleet.reply(id, decision)`.
9. The result is audited as `reply` with `deviceId: "ntfy"`, the namespaced server ID, the request ID, and the result.
10. Status 200 is success. The notification clears because the action used `clear: true`.
11. Status 404 or 409 is treated as a duplicate or expired request. It is logged and ignored.
12. Any other failure publishes a short failure notice to the outbound topic with priority 4 and the tag `warning`. The notice says the decision did not reach OpenCode and that the desktop or terminal prompt is still available.

The service does not publish a success ack. The cleared notification and the audit entry are the signal.

Reconnection:

- First run uses `since=10m`.
- Later runs use `since=<lastEventId>`.
- If the service was down, the saved cursor replays the missed replies from the ntfy cache.
- Duplicate IDs are ignored in memory, and `fleet.reply` rejects requests it has already forgotten.

## 13. Error handling

| Failure | Behavior |
|---|---|
| ntfy publish network error | Retry three times with 250 ms and 1 s backoff, then release seen IDs and log |
| ntfy publish 429 | Respect `Retry-After` when present, then retry |
| ntfy stream disconnect | Reconnect with jittered exponential backoff, capped at 60 seconds |
| ntfy stream 429 | Respect `Retry-After` |
| No stream bytes for 90 seconds | Abort and reconnect |
| Malformed NDJSON line | Log, skip, advance cursor |
| Oversized stream line | Drop the buffered line, log, reconnect if needed |
| Invalid HMAC | Log, ignore, advance cursor |
| Unknown request | `fleet.reply` returns 404, log, ignore |
| Duplicate action | `fleet.reply` returns 409 or 404, log, ignore |
| OpenCode unauthorized | `fleet.reply` returns 502, publish failure notice |
| OpenCode unavailable | `fleet.reply` returns 502, publish failure notice |
| Settings file corrupt | Exit with a clear message and a rotation hint |
| No servers | Exit with the discovery and setup guidance |
| Connect already running | Print the existing PID and `Run: npm run disconnect`, exit 1 |
| Stale PID file on connect | Remove it and continue starting |
| PID file cannot be written | Exit with the path and the permission error |
| Disconnect with no PID file | Print `No ntfy connection is running.`, exit 0 |
| Disconnect target already dead | Remove the stale PID file, print the same message, exit 0 |
| Disconnect target is not `scripts/ntfy.mjs` | Treat it as stale, do not signal, remove the file, exit 0 |
| Disconnect target does not exit within five seconds | Report that it is still running, exit 1, do not SIGKILL |
| Both phone and connect running | The CLI prints a warning; duplicate notification behavior is documented |

## 14. Security and privacy

- The outbound topic is a password. Anyone who knows it can read every approval and every action body, including the HMAC for that request. The QR contains it. Do not share the QR or the topic.
- The reply topic is also a password. Knowing only the reply topic does not allow forging a reply because the HMAC secret stays local. Knowing the outbound topic does allow replay of an action that has not yet been answered.
- Topics are 32 random bytes encoded as base64url, 43 characters, within the 64-character limit.
- The secret is 32 random bytes encoded as base64url. It is never sent to ntfy.
- HMAC verification uses `crypto.timingSafeEqual`.
- Public ntfy.sh sees the message content and the reply bodies. This is an accepted trade-off from the closed decision. Self-hosting is a future option, not part of this design.
- The CLI does not log the topics or the secret. `--show-topic` is required for manual iOS setup.
- `ntfy.json` is mode 0600. `seen.json` and audit files keep their existing permissions.
- Rotating topics and the secret is the response to a leak or a lost phone.
- Web Push is not called when ntfy is configured, so the stale FCM subscription cannot produce more VAPID errors from this path.

## 15. Testing

### Unit tests in `test/ntfy.test.mjs`

Tasks 2 and 3 add the message construction and stream cases below to this file, so this section describes the final file rather than Task 1 alone.

- Settings generation produces valid topic and secret formats and distinct topics.
- Settings validation rejects HTTP, a path, a missing secret, equal topics, and bad topic characters.
- `ntfyLink` produces the expected Android link and encodes the display name.
- `signReply` and `verifyReply` accept a valid signature and reject a changed decision, changed ID, missing field, and bad JSON.
- The action objects have the correct URL, method, headers, body, and `clear`.
- `buildRequestMessage` includes the server label, summary, command, path, and patterns.
- `fitMessage` keeps the serialized message under 4000 bytes and preserves the actions.
- The JSON stream parser handles partial lines, multiple lines per chunk, `open`, `keepalive`, and malformed lines.
- The cursor uses `since=10m` on first run and `since=<lastEventId>` after a message.
- Deduplication ignores a repeated message ID.
- Reconnect uses jittered backoff and honors `Retry-After`.

### Unit tests in `test/ntfy-lifecycle.test.mjs`

- `acquirePid` writes the current PID with mode 0600.
- A second `acquirePid` with a live PID throws and reports the owner.
- A stale PID file is replaced instead of blocking startup.
- `releasePid` removes the file only when it holds the expected PID.
- `readPid` returns null for a missing file and rejects malformed content.
- `stopPid` reports not running when the file is absent.
- `stopPid` removes a stale file when the PID is dead.
- `stopPid` sends SIGTERM to a real child process and reports stopped after it exits.
- `stopPid` reports still running when the process ignores SIGTERM, without sending SIGKILL.
- The Linux command-line check refuses to signal a process whose cmdline is not `scripts/ntfy.mjs`.
- PID helpers accept injected `kill`, `readCmdline`, and clock functions so these cases run without a live connect process.

### Integration tests in `test/ntfy-runtime.test.mjs`

A fake `fetchImpl` captures publishes and serves a scripted NDJSON stream.

- A pending request produces one ntfy publish with three actions.
- Ten fresh requests produce ten actionable messages, not a digest.
- More than 20 fresh requests publish 20 and leave the rest unseen for the next poll.
- A publish failure releases the seen IDs and the next poll retries.
- A valid reply calls `fleet.reply` and appends a `reply` audit entry.
- A duplicate reply is ignored after the first success.
- An invalid signature never calls `fleet.reply`.
- A test reply is audited and never calls `fleet.reply`.
- A 502 reply publishes a failure notice.
- Desktop notifications still fire in ntfy mode.
- Web Push is not called in ntfy mode.

### Updated tests in `test/notifications.test.mjs`

- Existing Web Push behavior is unchanged when `ntfy` is absent.
- `createNotifications` accepts ntfy without push or devices.
- `digest: false` is honored.
- `sendTest` uses ntfy when configured.
- ntfy mode sends no push and no digest.

### Manual checks

- Android: scan the QR, receive a real request, tap Allow once, confirm OpenCode proceeds.
- Android: tap Deny, confirm OpenCode rejects.
- Android: tap Always allow, confirm the permission is remembered.
- Android: run `--test`, tap Approve, confirm the ack.
- iOS: add the topic manually, receive a request, tap an action.
- Run `npm run disconnect` while connected, confirm the process exits and `data/ntfy.pid` is removed.
- Run `npm run connect` again, confirm it starts without a rescan and without printing a new pairing requirement.
- Run a second `npm run connect` while connected, confirm it refuses with the existing PID.
- Run `npm run disconnect` with no connection, confirm it exits 0 with the no-connection message.
- Stop ntfy, tap an action, restart within the cache window, confirm the reply is processed.
- Rotate, confirm the old phone stops receiving and the new QR works.

### Regression

- `npm test` must pass at or above the current 229 tests, plus the new tests.
- `npm run phone` behavior must be unchanged.
- The v1 compatibility files must be untouched.

## 16. Rollout

1. Implement and test the ntfy path.
2. Stop `npm run phone` before starting `npm run connect` to avoid two pollers and two notification sources.
3. Run `npm run connect`.
4. Scan the QR on Android.
5. Run `npm run connect -- --test` and tap Approve.
6. Confirm a real permission request arrives and replies.
7. Run `npm run disconnect` to stop the local service.
8. Run `npm run connect` again and confirm it starts with no rescan.
9. Keep `npm run phone` available for the browser path when ntfy is not configured.

There is no migration. `ntfy.json` is generated on first run. Existing Web Push data is left in place but is not used when ntfy is configured.

## 17. Limitations

- Android QR auto-subscribe only. iOS requires manual topic setup.
- Public ntfy.sh sees approval content.
- The outbound topic is a password. A leaked QR exposes approvals and replayable actions.
- No delivery guarantee. ntfy.sh caches for 12 hours by default.
- No multi-phone pairing. One data directory has one topic pair.
- No hot reload of the server list. New projects are picked up on restart, matching the current phone limitation.
- No success ack on the phone. The notification clears and the audit log records the result.
- Action reliability under Android battery optimization is a real-device check, not a code guarantee.
- No self-hosted ntfy, no ntfy account, no access tokens.
- No encryption of message content beyond HTTPS in transit.
- Connect runs in the foreground. There is no daemon, systemd unit, login item, or auto-start; closing the terminal stops approvals.
- Disconnect stops only the local Node process. It does not unsubscribe the phone, delete topics, or remove `ntfy.json`.
- PID reuse mitigation reads `/proc/<pid>/cmdline` only on Linux. Elsewhere a reused PID can make connect refuse until the stale PID file is removed manually.

## 18. Improvement decisions

The user asked for improvements after approving the design. These are the changes adopted into this spec.

| Improvement | Decision |
|---|---|
| Release seen IDs when publish fails | Adopt |
| Persist the reply cursor across restarts | Adopt |
| Fit the full payload under 4K after actions | Adopt |
| Make `--test` exercise the full reply path | Adopt |
| Use priority 4 and a warning tag | Adopt |
| Prefix the title with the server label | Adopt |
| Add `--no-always` to reduce accidental broad grants | Adopt |
| Use jittered reconnect, 429 handling, and a keepalive watchdog | Adopt |
| Treat duplicate and expired replies as idempotent | Adopt |
| Print exact iOS manual steps | Adopt |
| Publish a failure notice on reply failure | Adopt |
| Cap each announce at 20 fresh requests | Adopt |
| Avoid logging topics; require `--show-topic` for manual setup | Adopt |
| Warn when the LAN phone service may also be running | Adopt |
| Periodic server rediscovery | Defer |
| Self-hosted ntfy | Defer |
| Multiple phones | Defer |
| Success ack on the phone | Defer |
| Per-request nonce or timestamp in the HMAC | Defer |

## 19. Acceptance criteria

- `npm run connect` starts without an HTTP listener, TLS, CA, PWA, pairing code, devices, or Web Push.
- `npm run disconnect` stops the process started by connect, removes the PID file, and exits 0.
- Disconnect with no running service exits 0. A second connect while one is running is refused with the owner PID.
- After disconnect, connect reuses the saved settings and the phone needs no rescan.
- `npm run ntfy` remains an alias for connect.
- The PID file is mode 0600, holds only a decimal PID, and is removed on clean exit and startup failure.
- An Android scan of the QR subscribes the ntfy app to the outbound topic.
- A pending request produces one ntfy notification with Allow once, Always allow, and Deny.
- Each button posts a signed reply to the reply topic.
- The service verifies the signature and calls `fleet.reply`.
- The audit log records the reply with `deviceId: "ntfy"`.
- Desktop notifications still work.
- Web Push is not called in ntfy mode.
- `--test` exercises publish, action, stream, verification, and audit.
- `--rotate` replaces the topics and secret and invalidates the old QR.
- Publish failures release seen IDs and retry.
- The reply cursor survives a restart.
- The serialized notification stays under 4000 bytes.
- `npm run phone` and the existing tests are unchanged except for the new optional ntfy parameters.
- `npm test` passes.
- No runtime dependencies are added.

## 20. Open questions

None. The design has defaults for every choice. The remaining risks are real-device checks, not product decisions.
