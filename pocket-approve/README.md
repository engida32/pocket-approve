# pocket-approve

Phone and desktop approvals for OpenCode permission prompts.

This is the npm package and application folder. The full documentation, threat model, and contribution guide live in the repository root:

https://github.com/engida32/pocket-approve

Project page: https://engida32.github.io/pocket-approve/

## Install

```bash
npm ci
```

## Run

```bash
npm run setup -- --mode lan --host <your-lan-ip>
npm start
```

Or use the ntfy relay:

```bash
npm run connect
```

## Open and use

For local Web Push, open `http://<your-lan-ip>:8081/` on the phone and install the CA, then open `https://<your-lan-ip>:8443/`. Run `npm run pair -- --label "My phone"` and scan the QR code. Approve or deny the next OpenCode permission request from the inbox.

For ntfy, run `npm run connect`, scan the QR code with the ntfy app, and tap an action on the next request. Run `npm run connect -- --test` to send a test notification, and `npm run disconnect` when finished.

The fastest local path is `npm run phone`, which sets up LAN mode, starts the server, and prints the URLs and pairing QR. Run `npm run doctor` to check the current state.

## Test

```bash
npm test
```

## License

MIT
