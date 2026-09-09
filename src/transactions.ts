import { open, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { ProfileError } from "./contracts.js";

const LOCK_FILE = ".pi-profile.lock";
const LOCK_RETRIES = 100;
const LOCK_DELAY_MS = 50;

export interface MutationOwner {
  version: 1;
  id: string;
  hostname: string;
  pid: number;
  createdAt: string;
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function parseMutationOwner(input: unknown, path: string): MutationOwner {
  if (typeof input !== "object" || input === null) throw new ProfileError("LOCK_UNKNOWN", `Cannot verify mutation lock owner: ${path}`);
  const value = input as Partial<MutationOwner>;
  if (value.version !== 1 || typeof value.id !== "string" || !value.id || typeof value.hostname !== "string" ||
      !Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0 || typeof value.createdAt !== "string") {
    throw new ProfileError("LOCK_UNKNOWN", `Cannot verify mutation lock owner: ${path}`);
  }
  return value as MutationOwner;
}

async function readOwner(path: string): Promise<MutationOwner> {
  try {
    return parseMutationOwner(JSON.parse(await readFile(path, "utf8")), path);
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    throw new ProfileError("LOCK_UNKNOWN", `Cannot verify mutation lock owner: ${path}`);
  }
}

function pidStatus(pid: number): "live" | "absent" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "absent";
    return "unknown";
  }
}

export function assertStaleMutationOwner(owner: MutationOwner, context: string): void {
  if (owner.hostname !== hostname()) {
    throw new ProfileError("LOCK_REMOTE", `Cannot recover ${context} owned by another host (${owner.hostname})`);
  }
  const status = pidStatus(owner.pid);
  if (status === "live") throw new ProfileError("LOCK_ACTIVE", `${context} owner PID ${owner.pid} is active`);
  if (status === "unknown") throw new ProfileError("LOCK_UNKNOWN", `Cannot safely check ${context} owner PID ${owner.pid}`);
}

async function ownerVerifiedRemove(path: string, owner: MutationOwner): Promise<void> {
  const quarantine = `${path}.release-${randomUUID()}`;
  await rename(path, quarantine);
  try {
    const current = await readOwner(quarantine);
    if (current.id !== owner.id || current.hostname !== owner.hostname || current.pid !== owner.pid) {
      throw new ProfileError("LOCK_OWNERSHIP_LOST", `Mutation lock ownership changed; refusing to remove ${path}`);
    }
    await rm(quarantine);
  } catch (error) {
    try {
      await rename(quarantine, path);
    } catch (restoreError) {
      if ((restoreError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ProfileError("LOCK_OWNERSHIP_LOST", `Mutation lock ownership changed and remains quarantined at ${quarantine}`);
      }
    }
    throw error;
  }
}

export async function recoverMutationLock(profilesRoot: string): Promise<{ recovered: boolean; owner?: MutationOwner }> {
  const lockPath = join(profilesRoot, LOCK_FILE);
  let owner: MutationOwner;
  try {
    owner = await readOwner(lockPath);
  } catch (error) {
    if ((error as ProfileError).code === "LOCK_UNKNOWN") {
      try {
        await readFile(lockPath);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") return { recovered: false };
      }
    }
    throw error;
  }
  assertStaleMutationOwner(owner, `mutation lock ${lockPath}`);
  await ownerVerifiedRemove(lockPath, owner);
  return { recovered: true, owner };
}

export async function withMutationLock<T>(profilesRoot: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(profilesRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(profilesRoot, LOCK_FILE);
  const owner: MutationOwner = {
    version: 1,
    id: randomUUID(),
    hostname: hostname(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  let handle;
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt += 1) {
    try {
      const candidate = await open(lockPath, "wx", 0o600);
      try {
        await candidate.writeFile(`${JSON.stringify(owner)}\n`);
        handle = candidate;
      } catch (error) {
        await candidate.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === LOCK_RETRIES) {
        let detail = lockPath;
        try {
          const current = await readOwner(lockPath);
          detail = `${lockPath}; owner=${current.hostname}:${current.pid}; created=${current.createdAt}`;
        } catch {
          detail = `${lockPath}; owner could not be verified`;
        }
        throw new ProfileError("LOCK_BUSY", `Profile storage remained busy for ${LOCK_RETRIES * LOCK_DELAY_MS}ms (${detail}). Run pi-profile recover only after the owner has exited.`);
      }
      await delay(LOCK_DELAY_MS);
    }
  }
  if (!handle) throw new ProfileError("LOCK_BUSY", `Could not acquire profile mutation lock: ${lockPath}`);
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await ownerVerifiedRemove(lockPath, owner);
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
