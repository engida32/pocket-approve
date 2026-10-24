# Mobile approvals for OpenCode over Wi-Fi

Status: design report. The notifier is not implemented yet.

## The problem

OpenCode stops before it runs many shell commands, edits files, or touches paths outside the project. The prompt appears in the terminal. If you are away from the laptop, the agent waits.

This project puts that prompt on a phone on the same Wi-Fi. You get a notification with Allow and Deny, and the terminal continues. No account, no cloud login, and no hosted approval service.

## What success looks like

- A permission request produces a notification on the phone within a few seconds.
- The notification can allow the request once or reject it.
- The terminal prompt closes when the phone answers.
- The phone can open a page that shows the pending request and the command or file involved.
- The terminal still works when the phone is offline or the notifier is stopped.
- The laptop exposes nothing outside the local network.
- The repository contains no keys, tokens, certificates, or real network addresses.

Not in v1: more than one phone, "always allow", iPhone support, access from outside the LAN, and a hosted service.

## What we verified

Checked against opencode 1.19.0 on Linux.

- `opencode serve --hostname <LAN_IP> --port 4096` listens on the LAN. `opencode attach http://<LAN_IP>:4096` connects a terminal to that server.
- A session started in a bare `opencode` TUI is not reachable from another device. In our test, the TUI process had no listening TCP socket. Its server runs inside the process. Use `serve` plus `attach` when the phone needs to share the same permission queue.
- `GET /permission` returns pending permission requests across sessions.
- A request can be answered with `POST /session/{sessionID}/permissions/{permissionID}` and a JSON body of `{"response":"once"}` or `{"response":"reject"}`. The server also exposes `POST /permission/{requestID}/reply` with `{"reply":"once"|"always"|"reject"}`.
- The server exposes permission events on its event stream.
- The server prints a warning when `OPENCODE_SERVER_PASSWORD` is not set. Without it, any device that can reach the port can use the API.
- Web Push requires a secure context. On a LAN address that means HTTPS, not `http://<LAN_IP>`.
- Mobile browsers require persistent notifications shown by a service worker. The page-only `new Notification()` constructor is not enough.
- `ServiceWorkerRegistration.showNotification` supports action buttons.
- Web Push goes through the browser vendor's push service. On Chrome for Android that is typically Google's FCM. The developer does not need a Google account; the browser creates the subscription. The laptop needs outbound internet to send a push, and the phone needs internet to receive it.

End-to-end resolution from a second client has not been tested yet. The first implementation step is to prove it with two API clients before building the UI.

## Architecture

```
┌──────────────────┐        HTTP :4096        ┌─────────────────────┐
│ terminal         │  ──────────────────────▶ │ opencode serve      │
│ opencode attach  │                          │ <LAN_IP>:4096       │
└──────────────────┘                          └──────────┬──────────┘
                                                         │ GET /permission
                                                         │ every 2 s
                                                         ▼
┌──────────────────┐        HTTPS :8443       ┌─────────────────────┐
│ phone browser    │ ◀──────────────────────▶ │ mobile-notify       │
│ service worker   │        Web Push          │ polls, pushes,      │
│ approval page    │ ◀──────────────────────  │ answers requests    │
└──────────────────┘                          └─────────────────────┘
                                                         ▲
                                                         │ one-time CA
                                                         │ HTTP :8081
                                                         │
                                                      phone setup
```

### Components

1. **opencode server.** Runs on the laptop, bound to the LAN address. It owns the sessions and the permission queue. Every terminal attaches to it, so all clients see the same requests.
2. **Terminal clients.** `opencode attach http://<LAN_IP>:4096` with `-c` for the last session or `-s <id>` for a specific one. The normal terminal prompt remains the fallback.
3. **mobile-notify.** A small Node service. It holds the VAPID keys, the push subscriptions, and the access token. It polls `GET /permission`, sends a push for each new request, serves the approval page over HTTPS, and answers requests through the opencode API.
4. **Phone.** A browser page plus a service worker. The page handles setup and shows pending requests. The service worker receives pushes and handles notification clicks. No app install and no account.

### Why a sidecar instead of a plugin

The `permission.ask` plugin hook can change a decision before the prompt appears. A plugin could open its own HTTP server and wait for the phone. That works for one TUI process, but each additional TUI needs another port and another page, and a plugin loaded into a process cannot see requests raised by a different process.

The server model gives every terminal and the phone one queue. It also survives a terminal restart: the server keeps the session and the phone keeps its subscription. The cost is that sessions must be started under `opencode serve` and opened with `opencode attach`. Existing sessions are stored in the opencode database and can be resumed.

### Why polling

The server has an event stream, and a later version can subscribe to it. Polling `GET /permission` every two seconds is easier to reason about and recovers from a dropped connection without special code. At this scale the extra requests cost almost nothing.

### Why a local certificate authority

Web Push and service workers only run in a secure context. `http://<LAN_IP>` is not one. There are two ways to get HTTPS on a LAN address:

1. A public certificate for a domain that resolves to the laptop's LAN address. This needs a domain, DNS control, and a certificate renewal path.
2. A local CA and a server certificate with the LAN IP in `subjectAltName`. The phone trusts the CA once.

This design uses the second option. The CA private key stays on the laptop. The setup page serves only the CA certificate and installation instructions.

## Data flow

1. A tool call matches a permission rule with action `ask`.
2. opencode stores a permission request and shows the terminal prompt.
3. mobile-notify polls `GET /permission`. It remembers the ids it has already pushed.
4. For a new id, it sends a Web Push. The payload is small: the request id and a generic title. The command text is not in the push payload, because notifications can appear on a lock screen.
5. The notification offers Allow once and Deny where the platform supports action buttons. Otherwise, tapping the notification opens the approval page.
6. The decision goes to mobile-notify over HTTPS with the access token.
7. mobile-notify calls the opencode permission endpoint with `once` or `reject`.
8. opencode publishes the reply. The terminal prompt closes and the tool runs or is denied.

The notifier never decides on its own. If it cannot reach the server, it shows the error on the phone page and leaves the terminal prompt in place.

## Security

The opencode server can run commands. Treat it as a remote shell, not a status page.

- Bind the server and the notifier to the LAN address, not `0.0.0.0`. On a machine with a VPN interface such as Cloudflare WARP, `0.0.0.0` also listens there.
- Set `OPENCODE_SERVER_PASSWORD` when the phone feature is enabled. Without it, any device on the Wi-Fi can call the API directly, bypassing the notifier's token.
- Give the notifier a random token. The setup page puts it in the URL fragment, which browsers do not send to the server. The page stores it and sends it as a bearer token. The service worker reads it from IndexedDB when a notification action fires.
- Use HTTPS for the notifier. Without TLS, a device on the same Wi-Fi can read the token and the opencode password.
- Keep the push payload generic. Web Push payloads are encrypted to the browser subscription, but the notification itself can be read on a lock screen.
- Do not forward a port or put the server on a public tunnel. If you need access from outside the LAN, use a VPN and add authentication first.
- Keep the VAPID private key, the CA private key, the token, the subscriptions, and the opencode database out of git. The `.gitignore` covers them.
- The local CA is only as safe as the phone. Anyone who can install a certificate on the phone, or read its storage, can impersonate the notifier.

Threat model: someone on the same Wi-Fi, without the token or the opencode password. They can see that the ports exist and can reach the login page. They cannot answer a request or call the API. A person with access to the unlocked phone can answer requests, which is the point.

## Planned setup

The commands below describe the target workflow. They will work after the notifier is implemented.

```bash
# 1. Find the LAN address.
LAN_IP=$(ip -4 route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}')
echo "$LAN_IP"

# 2. Start the shared server.
export OPENCODE_SERVER_PASSWORD='choose-a-long-password'
opencode serve --hostname "$LAN_IP" --port 4096

# 3. In another terminal, attach.
opencode attach "http://$LAN_IP:4096" -c

# 4. Start the notifier.
cd mobile-approval
npm install
npm run setup     # creates the CA, server certificate, VAPID keys, and token
npm start
```

Phone setup:

1. Open `http://<LAN_IP>:8081` and install the CA certificate. On Android the menu is usually Settings, Security, Encryption and credentials, Install a certificate, CA certificate. The exact name varies by version.
2. Open the approval URL printed by `npm run setup`. It looks like `https://<LAN_IP>:8443/#token=...`.
3. Allow notifications when the browser asks.
4. Send a test notification and confirm that it arrives.

## Repository layout

```
personal-works/            repository root (this report)
  README.md
  REPORT.md
  LICENSE
  .gitignore
  mobile-approval/         planned implementation
    package.json
    server.mjs
    lib/opencode.mjs
    lib/push.mjs
    lib/tls.mjs
    public/index.html
    public/sw.js
    scripts/setup.mjs
    test/
```

The repository root is the existing `personal-works` workspace. The `.gitignore` tracks only this project's files, so the other folders in the workspace are not published.

## Test plan

1. **Round trip without a phone.** Start the server, create a session with `opencode run` or the API, trigger a `bash` permission, read `GET /permission`, reply with `once`, and confirm the tool ran. Repeat with `reject` and confirm it did not.
2. **Notification delivery.** Subscribe a desktop browser first, then the phone. Confirm a push arrives and that the service worker receives it.
3. **Action buttons.** Confirm Allow once and Deny answer the request without opening the page. Confirm the fallback page path works when actions are unavailable.
4. **Fallback.** Stop the notifier and confirm the terminal prompt still works. Disconnect the phone and confirm the request stays pending.
5. **Auth.** Confirm the notifier rejects a missing or wrong token, and that the opencode API rejects a wrong password.
6. **TLS.** Confirm Chrome on the phone accepts the certificate after the CA install, and that the setup page does not serve any secret.
7. **Restart.** Restart the notifier and the server. Confirm subscriptions survive and stale pending ids do not produce duplicate pushes.

## Limitations

- Two-second polling adds latency. A push typically arrives within a few seconds.
- v1 handles one phone. More phones need a subscription list and a way to show who answered.
- v1 has no "always allow". Each request is answered once or rejected.
- iPhone is out of scope for v1. Web Push on iOS has extra requirements and needs its own testing.
- The phone and the laptop must be on the same Wi-Fi for the approval page. Push delivery also needs internet on both devices.
- Notification action buttons depend on the browser and the operating system. The approval page is the fallback.
- The notifier is a separate process. It must be started after the opencode server, and it must be restarted if the token or keys change.

## Open questions

- Repository name. `personal-works` is the folder name; `mobile-approval` describes the project.
- License holder. The draft uses `engida32`.
- Should the notifier use the event stream instead of polling?
- Should "always allow" map to a per-session rule or a persistent config rule?
- Is iOS worth the extra setup for v2?

## License

MIT. See `LICENSE`.
