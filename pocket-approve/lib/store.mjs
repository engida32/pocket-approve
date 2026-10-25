import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function readPrivateJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

export async function writePrivateJson(file, value) {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temp = join(dir, `.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
  await chmod(file, 0o600);
}
