# Security Policy

## Supported versions

| Version | Status |
| --- | --- |
| 0.1.x (v2) | Supported |

v2 is the current line. The automated suite has 292 passing tests, and phone and desktop approvals have been verified end to end. The v1 notes in `REPORT.md` are historical.

## Reporting a vulnerability

Use GitHub private vulnerability reporting on the repository's Security tab. Do not open a public issue for a vulnerability.

Include the affected version, the configuration you used, reproduction steps, and the impact you observed. If the report involves a leaked topic or token, rotate it before attaching logs. Never include live secrets, private keys, VAPID keys, or OpenCode session data.

## Design rules

- Pocket Approve never approves a request on its own. An unanswered request stays pending.
- The local app binds to a specific LAN address. It does not bind `0.0.0.0`.
- The setup server is only for local pairing. Do not expose it to the public internet.
- HTTPS is required outside loopback. The LAN mode uses a local CA.
- The bearer token is kept in the URL fragment and is not sent in referrer headers.
- Do not forward ports or add a public tunnel to the local server.
- Keep VAPID keys, the CA key, device tokens, push subscriptions, `data/ntfy.json`, and the OpenCode database out of git.
- The ntfy topic is a secret. The action links use HMAC signatures, but the message body is not end-to-end encrypted.
- Treat the command or path in a notification as sensitive. It can appear on a lock screen.
- Use a self-hosted ntfy server when the command text must not pass through a third party.

## What the app does to reduce risk

- Pairing codes use 8 characters from a 32-symbol alphabet, expire after 10 minutes, and allow 5 attempts.
- Device tokens are 32 random bytes. Only a SHA-256 hash is stored, and token comparison is constant time.
- API writes require an exact Origin header and an authenticated device token. Unknown origins and missing tokens are rejected.
- Per-device and global rate limits cover reads, replies, pairing, subscriptions, tests, and authentication failures.
- API bodies are bounded, and static files come from a fixed map rather than a filesystem path.
- The audit log uses private file permissions, allowlisted fields, secret-like field redaction, and truncated values.
- Desktop notifications close after an action, so an answered prompt does not linger on screen.

## Threat model

### In scope

- Someone on the same Wi-Fi tries to reach the app without a device token.
- Someone finds the phone unlocked and taps a pending notification.
- A stale notification is tapped after the request was already answered.
- An attacker tries to guess a pairing code or brute-force a device token.
- An attacker tries to forge an ntfy action link without the HMAC key.
- A setup server or config file is accidentally exposed.

### Out of scope

- A compromised laptop, phone, browser, or operating system.
- A malicious browser extension with access to the page or notifications.
- An attacker who already has the config, HMAC key, device token, or root access.
- A malicious CA or a user who installs an untrusted root certificate.
- Vulnerabilities in OpenCode, ntfy, the browser, or the operating system.
- Physical access to an unlocked device with the app already open.

## Notification privacy

A desktop or phone notification can show the tool name and a one-line command or path. This is needed to make an informed decision. If that is unacceptable, reduce the notification detail in your deployment or use a private lock screen setting. A generic-title option is on the roadmap.

The ntfy path sends the notification through a relay. ntfy.sh can read the content. HMAC signs the action links and does not encrypt the message. Self-host ntfy or use the local Web Push path if the content must not leave your network.

## Secrets and rotation

Rotate the ntfy topic with `npm run connect -- --rotate` if it leaks. Revoke a lost phone with `npm run revoke -- <device-id>`. Replace the local CA and re-pair if the CA key is exposed. Review `data/audit.jsonl` for unexpected replies.

## Disclosure

Please give the maintainers a reasonable window to fix the issue before publishing details. Credit is available on request.
