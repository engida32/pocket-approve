# Mobile approvals for OpenCode

Approve OpenCode permission prompts from a phone on the same Wi-Fi. No account.

Status: design. The notifier is not implemented yet. See [REPORT.md](REPORT.md) for the full design.

## The idea

Run one OpenCode server on the laptop. Attach terminals to it. A small local service watches the permission queue, sends a Web Push to the phone, and answers the request when you tap Allow or Deny. The terminal stays open as the fallback.

## What is in this repository

- `REPORT.md`: the design, the verified API facts, the security model, and the test plan.
- No code yet.

## Safety

The OpenCode server runs commands. Keep it on the LAN, set `OPENCODE_SERVER_PASSWORD`, and do not forward a port. The report explains the token and TLS setup.

## License

MIT.
