import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { Lease, Profile } from "./contracts.js";
import { ProfileError } from "./contracts.js";
import { atomicWriteJson, withMutationLock } from "./transactions.js";

export const LEASE_DIRECTORY = ".pi-profile-leases";
const LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface LeaseEvidence extends Lease {
  path: string;
  raw: string;
}

export interface LeaseInspection {
  active: LeaseEvidence[];
  ambiguous: LeaseEvidence[];
  stale: LeaseEvidence[];
}

function parseLease(value: unknown): Lease {
  if (typeof value !== "object" || value === null) throw new ProfileError("INVALID_LEASE", "Malformed profile lease");
  const lease = value as Partial<Lease>;
  if (lease.version !== 1 || typeof lease.id !== "string" || !LEASE_ID.test(lease.id) || typeof lease.hostname !== "string" ||
      !Number.isSafeInteger(lease.launcherPid) || (lease.launcherPid ?? 0) <= 0 ||
      (lease.childPid !== null && (!Number.isSafeInteger(lease.childPid) || (lease.childPid ?? 0) <= 0)) ||
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

function contained(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent !== ".." && !fromParent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(fromParent);
}

function inspectionError(path: string): ProfileError {
  return new ProfileError("INVALID_LEASE", `Cannot safely inspect lease: ${path}. Inspect it manually; do not remove it unless every recorded process is proven absent.`);
}

export async function inspectLeases(profile: Profile): Promise<LeaseInspection> {
  const result: LeaseInspection = { active: [], ambiguous: [], stale: [] };
  const directory = join(profile.root, LEASE_DIRECTORY);
  let entries: string[];
  let canonicalDirectory: string;
  try {
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw inspectionError(directory);
    canonicalDirectory = await realpath(directory);
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    if (error instanceof ProfileError) throw error;
    throw inspectionError(directory);
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const listedPath = join(canonicalDirectory, entry);
    let evidence: LeaseEvidence;
    try {
      const stats = await lstat(listedPath);
      if (!stats.isFile() || stats.isSymbolicLink()) throw inspectionError(listedPath);
      const authoritativePath = await realpath(listedPath);
      if (!contained(canonicalDirectory, authoritativePath)) throw inspectionError(listedPath);
      const raw = await readFile(authoritativePath, "utf8");
      const lease = parseLease(JSON.parse(raw));
      if (entry !== `${lease.id}.json` || basename(authoritativePath) !== entry) throw inspectionError(listedPath);
      evidence = { ...lease, path: authoritativePath, raw };
    } catch (error) {
      if (error instanceof ProfileError) throw error;
      throw inspectionError(listedPath);
    }
    if (evidence.hostname !== hostname()) {
      result.ambiguous.push(evidence);
      continue;
    }
    const launcher = pidStatus(evidence.launcherPid);
    const child = evidence.childPid === null ? "absent" : pidStatus(evidence.childPid);
    if (launcher === "live" || child === "live") result.active.push(evidence);
    else if (launcher === "ambiguous" || child === "ambiguous" || evidence.state === "starting") result.ambiguous.push(evidence);
    else result.stale.push(evidence);
  }
  return result;
}

export async function clearStaleLeases(
  profile: Profile,
  options: { beforeRemove?: (evidence: LeaseEvidence) => void | Promise<void> } = {},
): Promise<number> {
  const inspection = await inspectLeases(profile);
  for (const evidence of inspection.stale) {
    await options.beforeRemove?.(evidence);
    const quarantine = `${evidence.path}.clear-${randomUUID()}`;
    try {
      await rename(evidence.path, quarantine);
    } catch (error) {
      throw new ProfileError("LEASE_CHANGED", `Stale lease changed before cleanup; inspect ${evidence.path}: ${(error as Error).message}`);
    }
    try {
      const quarantineStat = await lstat(quarantine);
      if (!quarantineStat.isFile() || quarantineStat.isSymbolicLink()) {
        throw new ProfileError("LEASE_CHANGED", `Stale lease path changed type before cleanup; refusing to remove ${evidence.path}`);
      }
      const currentRaw = await readFile(quarantine, "utf8");
      const current = parseLease(JSON.parse(currentRaw));
      if (currentRaw !== evidence.raw || current.id !== evidence.id) {
        throw new ProfileError("LEASE_CHANGED", `Stale lease changed before cleanup; refusing to remove ${evidence.path}`);
      }
      await rm(quarantine);
    } catch (error) {
      try {
        await rename(quarantine, evidence.path);
      } catch {
        throw new ProfileError("LEASE_CHANGED", `Changed lease evidence remains quarantined at ${quarantine}`);
      }
      if (error instanceof ProfileError && error.code === "LEASE_CHANGED") throw error;
      throw new ProfileError("LEASE_CHANGED", `Stale lease could not be owner-verified; inspect ${evidence.path}`);
    }
  }
  return inspection.stale.length;
}

export async function acquireLease(profile: Profile): Promise<{
  lease: Lease;
  path: string;
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
      path,
      async setChild(pid: number) {
        if (released) throw new ProfileError("LEASE_RELEASED", "Cannot publish a child PID after this launch lease was released");
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new ProfileError("INVALID_CHILD_PID", "Cannot publish invalid child PID");
        lease = { ...lease, childPid: pid, state: "running" };
        await atomicWriteJson(path, lease);
      },
      async release() {
        if (released) return;
        const quarantine = `${path}.release-${randomUUID()}`;
        try {
          await rename(path, quarantine);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            released = true;
            return;
          }
          throw error;
        }
        try {
          const current = parseLease(JSON.parse(await readFile(quarantine, "utf8")));
          const unchanged = current.id === lease.id && current.hostname === lease.hostname &&
            current.launcherPid === lease.launcherPid && current.childPid === lease.childPid &&
            current.createdAt === lease.createdAt && current.state === lease.state;
          if (!unchanged) throw new ProfileError("LEASE_OWNERSHIP_LOST", `Lease evidence changed; refusing to remove ${path}`);
          await rm(quarantine);
          released = true;
        } catch (error) {
          try {
            await rename(quarantine, path);
          } catch {
            throw new ProfileError("LEASE_OWNERSHIP_LOST", `Lease evidence changed and remains quarantined at ${quarantine}`);
          }
          throw error;
        }
      },
    };
  });
}
