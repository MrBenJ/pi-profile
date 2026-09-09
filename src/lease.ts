import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { Lease, Profile } from "./contracts.js";
import { ProfileError } from "./contracts.js";
import { atomicWriteJson, withMutationLock } from "./transactions.js";

const LEASE_DIRECTORY = ".pi-profile-leases";

export interface LeaseInspection {
  active: Lease[];
  ambiguous: Lease[];
  stale: Lease[];
}

function parseLease(value: unknown): Lease {
  if (typeof value !== "object" || value === null) throw new ProfileError("INVALID_LEASE", "Malformed profile lease");
  const lease = value as Partial<Lease>;
  if (lease.version !== 1 || typeof lease.id !== "string" || typeof lease.hostname !== "string" ||
      !Number.isSafeInteger(lease.launcherPid) || (lease.childPid !== null && !Number.isSafeInteger(lease.childPid)) ||
      typeof lease.createdAt !== "string" || !["starting", "running", "exited"].includes(lease.state ?? "")) {
    throw new ProfileError("INVALID_LEASE", "Malformed profile lease");
  }
  return lease as Lease;
}

function pidStatus(pid: number): "live" | "absent" | "ambiguous" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "absent";
    return "ambiguous";
  }
}

export async function inspectLeases(profile: Profile): Promise<LeaseInspection> {
  const result: LeaseInspection = { active: [], ambiguous: [], stale: [] };
  const directory = join(profile.root, LEASE_DIRECTORY);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    let lease: Lease;
    try {
      lease = parseLease(JSON.parse(await readFile(join(directory, entry), "utf8")));
    } catch {
      throw new ProfileError("INVALID_LEASE", `Cannot safely inspect lease: ${join(directory, entry)}`);
    }
    if (lease.hostname !== hostname()) {
      result.ambiguous.push(lease);
      continue;
    }
    const launcher = pidStatus(lease.launcherPid);
    const child = lease.childPid === null ? "absent" : pidStatus(lease.childPid);
    if (launcher === "live" || child === "live") result.active.push(lease);
    else if (launcher === "ambiguous" || child === "ambiguous" || lease.state === "starting") result.ambiguous.push(lease);
    else result.stale.push(lease);
  }
  return result;
}

export async function clearStaleLeases(profile: Profile): Promise<number> {
  const inspection = await inspectLeases(profile);
  for (const lease of inspection.stale) {
    await rm(join(profile.root, LEASE_DIRECTORY, `${lease.id}.json`), { force: true });
  }
  return inspection.stale.length;
}

export async function acquireLease(profile: Profile): Promise<{
  lease: Lease;
  setChild(pid: number): Promise<void>;
  release(): Promise<void>;
}> {
  const profilesRoot = dirname(profile.root);
  return withMutationLock(profilesRoot, async () => {
    let rootStat;
    try {
      rootStat = await lstat(profile.root);
    } catch {
      throw new ProfileError("PROFILE_NOT_FOUND", `Cannot lease missing profile: ${profile.metadata.name}`);
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new ProfileError("INVALID_PROFILE", `Cannot lease unsafe profile root: ${profile.root}`);
    }
    const directory = join(profile.root, LEASE_DIRECTORY);
    await mkdir(directory, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    let lease: Lease = {
      version: 1,
      id: randomUUID(),
      hostname: hostname(),
      launcherPid: process.pid,
      childPid: null,
      createdAt: new Date().toISOString(),
      state: "starting",
    };
    const path = join(directory, `${lease.id}.json`);
    await atomicWriteJson(path, lease);
    let released = false;
    return {
      lease,
      async setChild(pid: number) {
        if (released || !Number.isSafeInteger(pid) || pid <= 0) throw new ProfileError("INVALID_CHILD_PID", "Cannot publish invalid child PID");
        lease = { ...lease, childPid: pid, state: "running" };
        await atomicWriteJson(path, lease);
      },
      async release() {
        if (released) return;
        released = true;
        lease = { ...lease, state: "exited" };
        await atomicWriteJson(path, lease).catch(() => undefined);
        await rm(path, { force: true });
      },
    };
  });
}
