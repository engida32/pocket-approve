import { pathToFileURL } from "node:url";
import { start } from "./lib/runtime.mjs";

async function main() {
  const running = await start();
  console.log(`Pocket Approve v2 listening on ${running.config.mode} port ${running.port}`);
  if (running.config.mode === "lan") {
    console.log(`Certificate setup: http://${running.config.host}:${running.setupPort}/`);
  }

  let stopping = false;
  async function stop(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}, stopping`);
    await running.stop();
    process.exit(0);
  }

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  return running;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  });
}

export { start };
