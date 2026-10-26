# Contributing to Pocket Approve

Thanks for helping. Small, focused changes are easiest to review.

## Before you start

- Search existing issues and pull requests.
- Open an issue for a new adapter, a protocol change, or a large refactor.
- Do not include real command output, tokens, topics, certificates, private keys, or OpenCode session data in an issue.
- Report vulnerabilities through GitHub private vulnerability reporting, not a public issue. See [SECURITY.md](SECURITY.md).

## Development setup

```bash
git clone https://github.com/engida32/pocket-approve.git
cd pocket-approve/pocket-approve
npm ci
npm test
```

Node.js 20 or newer is required. The project uses ESM and plain Node APIs. It does not need a bundler or a build step.

For a local run:

```bash
npm run setup -- --mode lan --host <your-lan-ip>
npm start
```

For the ntfy path:

```bash
npm run connect
```

## Tests

Run the full suite before opening a pull request:

```bash
npm test
```

The suite uses `node --test`. Add a focused test for every behavior change, including error paths. If you change a notification, pairing, authentication, rate-limit, or config path, include the test that would fail without your fix.

## Style

- Use ESM, `const`, and small named functions.
- Match the surrounding code. Do not add a framework or a runtime dependency without discussing it first.
- Keep user-facing prose direct and free of marketing language.
- Do not add comments that restate the code. Add a comment only when the reason is not obvious.
- Do not use em dashes in documentation or user-facing text.
- Keep secrets out of logs, fixtures, and screenshots.

## Pull requests

A good pull request has:

- One problem and one reason for the change.
- A short description of the behavior before and after.
- Tests for the change.
- Updated documentation when commands, configuration, or security behavior changes.
- No unrelated formatting or refactoring.

If a change affects the security model, call it out in the pull request and update [SECURITY.md](SECURITY.md).

## Commit messages

Use a short imperative subject. Explain the why in the body when it is not obvious. Keep each commit reviewable.

## License

By contributing, you agree that your contribution is licensed under the MIT License in [LICENSE](LICENSE).
