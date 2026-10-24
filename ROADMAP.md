# Roadmap

Pocket Approve starts with OpenCode because that is what I use every day. The approval queue sits beside the agent, not inside it, so another tool can feed the same phone and desktop notifications.

## Status

- **Now:** design and API verification.
- **Next:** the OpenCode adapter and the first working build.
- **Later:** more agents.

## v1: OpenCode, desktop and Android

- [ ] Sidecar polls `GET /permission` every 2 s.
- [ ] Desktop notification with Allow once, Allow always, Deny.
- [ ] Android Web Push with the same actions.
- [ ] Approval page over HTTPS with a local CA.
- [ ] Token auth and optional OpenCode server password.
- [ ] One phone, one shared queue.
- [ ] Test plan from REPORT.md passes.

## v1.1: Less friction

- [ ] Close the desktop notification when the phone answers, and the reverse.
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
| OpenCode | HTTP permission API | v1 |
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
