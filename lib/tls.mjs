import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function readTls(dataDir) {
  const [key, cert] = await Promise.all([
    readFile(join(dataDir, "server.key"), "utf8"),
    readFile(join(dataDir, "server.crt"), "utf8"),
  ]);
  return { key, cert };
}

export async function certHasIp(certPath, ip) {
  const { stdout } = await run("openssl", [
    "x509",
    "-in",
    certPath,
    "-noout",
    "-text",
  ]);
  const ips = [...stdout.matchAll(/IP Address:([0-9a-fA-F:.]+)/g)].map(
    (match) => match[1],
  );
  return ips.includes(ip);
}
