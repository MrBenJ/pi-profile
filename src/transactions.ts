import { open, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProfileError } from "./contracts.js";

const LOCK_FILE = ".pi-profile.lock";
const LOCK_RETRIES = 40;
const LOCK_DELAY_MS = 25;

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function withMutationLock<T>(profilesRoot: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(profilesRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(profilesRoot, LOCK_FILE);
  let handle;
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === LOCK_RETRIES) {
        throw new ProfileError("LOCK_BUSY", `Profile storage is busy; retry after the other operation finishes (${lockPath})`);
      }
      await delay(LOCK_DELAY_MS);
    }
  }
  if (!handle) throw new ProfileError("LOCK_BUSY", `Could not acquire profile mutation lock: ${lockPath}`);
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${path.split(/[\\/]/).at(-1)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function transactionPath(profilesRoot: string, token: string): string {
  return join(profilesRoot, `.pi-profile-journal-${token}.json`);
}
