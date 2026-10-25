import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
  const temp = join(
    dir,
    `.${basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let created = false;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    created = true;
    await chmod(temp, 0o600);
    await rename(temp, file);
    created = false;
    await chmod(file, 0o600);
  } catch (error) {
    if (created) await rm(temp, { force: true });
    throw error;
  }
}
