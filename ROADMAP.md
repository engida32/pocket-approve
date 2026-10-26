# Roadmap

Pocket Approve starts with OpenCode because that is what I use every day. The approval queue sits beside the agent, not inside it, so another tool can feed the same phone and desktop notifications.

## Status

> **Current status (2026-10-26):** the v2 implementation passes 292 of 292 tests. The phone and desktop approval paths have been exercised end to end. The release adds an ntfy relay alongside local Web Push, multi-server routing, and a hardened approval API. This roadmap keeps the original v1 plan below as history.

- **Now:** v2 is implemented and verified. Open-source packaging, CI, and security documentation are in place.
- **Next:** the remaining v1.1 usability work, starting with cross-client dismissal.
- **Later:** more agents and desktop platforms.

## v1: OpenCode, desktop and Android

- [x] Sidecar polls `GET /permission` every 2 s.
- [x] Desktop notification with Allow once, Allow always, Deny.
- [x] Android Web Push with the same actions.
- [x] Approval page over HTTPS with a local CA.
- [x] Token auth and optional OpenCode server password.
- [x] One phone, one shared queue.
- [x] Test plan from REPORT.md passes.

All seven v1 items are implemented and verified. The desktop path uses `gdbus`, not `notify-send`, because `notify-send` 0.8.8 drops action buttons here. Chromium shows at most two notification actions, so Allow once and Deny appear there and the page always shows all three. Full cross-client dismissal is v1.1; v1 closes desktop notifications and drops answered requests from an open phone page. `Allow always` is at least project or server-process scoped; the saved-permission endpoint returned no entry, so the exact scope is unproven.

## v1.1: Less friction

- [ ] Close the phone notification when the desktop answers. v1 already closes the desktop notification and drops answered requests from an open phone page.
- [ ] Multiple phones. Show who answered.
- [ ] Per-session mute and an "open terminal" action.
- [ ] Subscribe to the event stream instead of polling.
- [ ] A small audit log of decisions.

## v2: More places

- [ ] iOS. Web Push for home-screen web apps, with the same action buttons where iOS allows them.
- [ ] macOS and Windows desktop notifications.
- [ ] A generic CLI adapter: `pocket-approve ask --title "..." --body "..."` returns once, always, or reject. Any script can call it.
- [ ] A stable adapter API and a test harness.

## Tool support

| Tool | How it plugs in | Status |
|---|---|---|
| OpenCode | HTTP permission API | v1 implemented |
| Generic CLI | `pocket-approve ask` | v2 |
| Claude Code | Hooks, to be verified | Exploring |
| Codex CLI | Hook or PTY wrapper, to be investigated | Exploring |
| Gemini CLI | Adapter, to be investigated | Exploring |
| Aider | PTY wrapper | Exploring |

The table is a direction, not a promise. Each tool has its own approval model, and some may not expose a clean hook.

## Adapter interface

```ts
type Decision = "once" | "always" | "reject";

interface Request {
  id: string;
  source: string;
  session?: string;
  title: string;
  detail?: string;
  createdAt: number;
}

interface ApprovalSource {
  name: string;
  list(): Promise<Request[]>;
  reply(id: string, decision: Decision): Promise<void>;
}
```

The core owns the queue, the phone page, Web Push, desktop notifications, and the token. An adapter only lists pending requests and replies to one. That keeps a new agent from reimplementing the notification path.

## Not planned

- A hosted service that sees your commands.
- Silent approval. Every request waits for a person.
- Access from outside your network without a VPN.

## How to help

Open an issue if you use one of the listed tools and know how its approval prompt can be intercepted. A link to the docs or a small proof of concept is more useful than a feature request.
