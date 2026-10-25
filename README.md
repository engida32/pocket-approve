# Pocket Approve

Approve your coding agent from your pocket.

![status: v1](https://img.shields.io/badge/status-v1-green)
![license: MIT](https://img.shields.io/badge/license-MIT-blue)
![platform: Linux](https://img.shields.io/badge/platform-Linux-lightgrey)

Your agent hits a permission prompt. You are on the couch, in a meeting, or three terminals deep and not sure which one is waiting. Pocket Approve sends the request to your phone and your desktop. Tap Allow once, Allow always, or Deny. The agent keeps moving.

**Status: v1 implemented.** The automated suite passes 66 of 66 tests. The live phone and desktop path has not been manually verified yet; the checklist is in [REPORT.md](REPORT.md). The report also has the verified API facts, architecture, and security model.

## What you get

- A desktop notification with the tool and a one-line summary, plus Allow once, Allow always, and Deny. It goes through `gdbus`.
- A phone push over your Wi-Fi. No account and no cloud dashboard. Chromium shows two actions in the notification (Allow once and Deny); the page always shows all three.
- One queue for every terminal attached to the shared OpenCode server. Answer once; the terminal prompt closes, the desktop notification closes, and an open phone page drops the request on its next poll.
- The terminal prompt stays as the fallback. If the notifier stops, nothing breaks.

Pocket Approve never approves anything on its own. If it cannot reach the server, it says so and leaves the terminal prompt in place.

## How it works

```mermaid
flowchart LR
  T["Terminal<br/>opencode attach"] <-->|"HTTP :4096"| S["OpenCode server<br/>LAN address"]
  S -->|"GET /permission every 2 s"| P["pocket-approve<br/>local service"]
  P -->|"Web Push"| PH["Phone<br/>service worker"]
  P -->|"gdbus"| D["Desktop<br/>notification actions"]
  PH -->|"Allow / Always / Deny"| P
  D -->|"Allow / Always / Deny"| P
  P -->|"reply"| S
  C["Phone setup<br/>HTTP :8081"] -.->|"install CA once"| PH
```

OpenCode sessions have to run under `opencode serve`; terminals join with `opencode attach`. A bare TUI keeps its server inside the process and cannot be reached from another device. The local service watches `GET /permission`, sends the push and the desktop notification, and replies through the OpenCode API. Phone push needs HTTPS and a service worker, so setup creates a local CA and a certificate for your LAN address. The desktop path calls the notification daemon directly with `gdbus`. `notify-send` 0.8.8 drops action buttons on the tested machine, so it is not used.

## What it will not do

- No account and no hosted approval service.
- No port forwarding or public tunnel.
- No silent approval.

## Requirements

- Linux desktop with a notification daemon that supports actions and `gdbus` from GLib. Built on GNOME 50.1.
- Node.js 20 or newer. The suite ran on Node 24.21.0.
- OpenCode 1.19 or newer.
- Android with Chrome for the first phone release. iPhone is on the roadmap.
- Laptop and phone on the same Wi-Fi. Push delivery also needs internet on both.
- A one-time local CA install on the phone.

## Roadmap

- **v1:** implemented. OpenCode, GNOME desktop actions, Android Web Push, one phone, Allow once / Allow always / Deny.
- **v1.1:** close the phone notification when the desktop answers, multiple phones, per-session routing.
- **v2:** iOS, macOS and Windows notifications, a generic CLI adapter.
- **v2.x:** Claude Code, Codex CLI, Gemini CLI, Aider.

v1 closes the desktop notification when a request is answered through the sidecar and drops answered requests from an open phone page. Full cross-client dismissal, including the phone notification when the desktop answers, is v1.1. `Allow always` is at least project or server-process scoped in the 2026-10-25 probe. The saved-permission endpoint returned no entry, so the exact scope is unproven.

[ROADMAP.md](ROADMAP.md) has the details and the adapter interface.

## Repository contents

- `REPORT.md`: verified API facts, architecture, security model, test plan, and the pending manual checklist.
- `ROADMAP.md`: phases and tool support.
- `SECURITY.md`: reporting and the threat model.
- `pocket-approve/`: the Node service, phone page, and tests.

## Safety

The OpenCode server can run commands. Treat it like a remote shell. Keep it on the LAN, set `OPENCODE_SERVER_PASSWORD`, use the notifier's token and HTTPS, and do not forward a port. [SECURITY.md](SECURITY.md) explains the model.

## Contributing

This is early. If you use OpenCode on Linux and want to run the manual checklist, open an issue with your desktop environment and phone model. Adapter ideas are welcome, especially for agents you use every day.

## License

MIT. See [LICENSE](LICENSE).
