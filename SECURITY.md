# Security

Pocket Approve sits between you and a process that can run commands. Treat the OpenCode server and the Pocket Approve service as remote shells.

## Supported versions

v1 is implemented and the automated suite passes. The live phone and desktop path is pending manual verification. Security fixes target the latest v1 release; include the version from `pocket-approve/package.json` and the commit you run.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository. Open the Security tab and choose "Report a vulnerability". Do not open a public issue for a vulnerability.

Include the version, your desktop environment, the phone browser, and the steps to reproduce. A proof of concept helps.

## Design rules

- Bind OpenCode and Pocket Approve to the LAN address. Do not use `0.0.0.0` on a machine with a VPN interface.
- Set `OPENCODE_SERVER_PASSWORD`. Without it, any device on the Wi-Fi can call the API.
- Serve the approval page over HTTPS with a local CA. HTTP exposes the token and the password.
- Put the access token in the URL fragment, store it in the browser, and send it as a bearer token. Rotate it if the phone is lost.
- Do not forward a port or use a public tunnel. Use a VPN if you need access from outside.
- Keep the VAPID private key, the CA private key, the token, push subscriptions, and the OpenCode database out of git.
- The service never approves on its own. A failed request leaves the terminal prompt in place.

## Threat model

In scope:

- Someone on the same Wi-Fi without the token or the OpenCode password.
- A person who finds an unlocked phone.
- A stale notification that could answer the wrong request.

Out of scope:

- A compromised laptop or phone.
- A malicious browser extension with access to the approval page.
- A person who can install a trusted certificate on the phone.

## What the notifications reveal

The desktop notification shows the tool and a one-line summary of the command or path. Anyone who can see the screen can read it. Phone notifications can appear on the lock screen. A future setting will send a generic title when you are in public.
