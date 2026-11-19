# Changelog

All notable changes to Pocket Approve are recorded here.

## 2.0.0 - 2026-11-19

### Added

- ntfy relay path with QR pairing, HMAC action links, topic rotation, and a test request.
- Local Web Push path with a local CA and a phone PWA.
- Desktop notifications through GNOME and gdbus.
- Device pairing, revocation, scoped tokens, rate limits, and an audit log.
- Multi-server support with namespaced request IDs.
- `/api/health`, `/api/pair`, and the v2 admin CLI.

### Fixed

- Desktop notifications now close after an action.
- Phone replies now close the matching desktop notification with a valid `uint32` ID.
- ntfy sync no longer produces duplicate notifications in the current process.
- Expired rate-limit buckets are swept instead of retained for the life of the process.
- Device token hashes are compared in constant time.

### Changed

- The package now lives at the repository root, so `git clone && npm ci && npm test` works from a fresh checkout.
- `homepage` points at the project page instead of the README.
- CI covers Node 20, 22 and 24.
- Removed the unused `trustProxy` config field.
- Removed the temporary desktop debug logging.
- The v2 docs now cover both the local Web Push path and the ntfy relay.

## 0.1.0

Initial public release.
