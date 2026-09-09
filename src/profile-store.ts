import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Profile, ProfileMetadata, StoreOptions } from "./contracts.js";
import { ProfileError } from "./contracts.js";
import { inspectLeases, clearStaleLeases } from "./lease.js";
import { parseMetadata, validateName } from "./metadata.js";
import { profilePath } from "./paths.js";
import { atomicWriteJson, transactionPath, withMutationLock } from "./transactions.js";

const MARKER = ".pi-profile.json";

async function pathKind(path: string): Promise<"missing" | "directory" | "file" | "symlink"> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    return "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

export class ProfileStore {
  readonly profilesRoot: string;
  private readonly now: () => Date;
  private readonly fault?: StoreOptions["fault"];

  constructor(options: StoreOptions) {
    this.profilesRoot = options.profilesRoot;
    this.now = options.now;
    this.fault = options.fault;
  }

  metadata(name: string, input: Partial<Pick<ProfileMetadata, "defaultCwd" | "inheritEnvironment">> = {}): ProfileMetadata {
    return {
      version: 1,
      name: validateName(name),
      defaultCwd: input.defaultCwd ?? null,
      inheritEnvironment: input.inheritEnvironment ?? [],
      createdAt: this.now().toISOString(),
    };
  }

  async create(metadata: ProfileMetadata): Promise<Profile> {
    return this.createPopulated(metadata, async () => undefined);
  }

  async createPopulated(metadata: ProfileMetadata, populate: (stagingRoot: string) => Promise<void>): Promise<Profile> {
    const parsed = parseMetadata(metadata);
    return withMutationLock(this.profilesRoot, async () => {
      await this.assertNoUncertainJournal();
      const destination = profilePath(this.profilesRoot, parsed.name);
      if (await pathKind(destination) !== "missing") throw new ProfileError("PROFILE_EXISTS", `Profile already exists: ${parsed.name}`);
      const token = randomUUID();
      const staging = join(this.profilesRoot, `.pi-profile-create-${parsed.name}-${token}`);
      const journal = transactionPath(this.profilesRoot, token);
      await atomicWriteJson(journal, { version: 1, operation: "create", staging, destination });
      try {
        await mkdir(staging, { mode: 0o700 });
        await populate(staging);
        await atomicWriteJson(join(staging, MARKER), parsed);
        await this.fault?.("create-before-promotion");
        if (await pathKind(destination) !== "missing") throw new ProfileError("PROFILE_EXISTS", `Profile already exists: ${parsed.name}`);
        await rename(staging, destination);
        await rm(journal, { force: true });
        return { root: destination, metadata: parsed };
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        await rm(journal, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async list(): Promise<Profile[]> {
    try {
      await this.assertNoUncertainJournal();
      const entries = await readdir(this.profilesRoot, { withFileTypes: true });
      const profiles: Profile[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".") || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        try {
          profiles.push(await this.get(entry.name));
        } catch (error) {
          if (error instanceof ProfileError && error.code === "INVALID_NAME") continue;
          throw error;
        }
      }
      return profiles.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async get(name: string): Promise<Profile> {
    validateName(name);
    await this.assertNoUncertainJournal();
    const root = profilePath(this.profilesRoot, name);
    if (await pathKind(root) !== "directory") throw new ProfileError("PROFILE_NOT_FOUND", `Profile not found: ${name}`);
    const marker = join(root, MARKER);
    if (await pathKind(marker) !== "file") throw new ProfileError("INVALID_PROFILE", `Profile marker is missing or unsafe: ${marker}`);
    let parsed: ProfileMetadata;
    try {
      parsed = parseMetadata(JSON.parse(await readFile(marker, "utf8")));
    } catch (error) {
      if (error instanceof ProfileError) throw error;
      throw new ProfileError("INVALID_PROFILE", `Profile marker is not valid JSON: ${marker}`);
    }
    if (parsed.name !== name) throw new ProfileError("PROFILE_MISMATCH", `Profile marker name does not match directory: ${root}`);
    return { root, metadata: parsed };
  }

  async update(name: string, metadata: ProfileMetadata): Promise<void> {
    const parsed = parseMetadata(metadata);
    if (parsed.name !== validateName(name)) throw new ProfileError("PROFILE_MISMATCH", "Updated metadata name must match the profile");
    await withMutationLock(this.profilesRoot, async () => {
      const profile = await this.get(name);
      await atomicWriteJson(join(profile.root, MARKER), parsed);
    });
  }

  async rename(oldName: string, newName: string, options: { clearStaleLeases?: boolean } = {}): Promise<void> {
    validateName(oldName);
    validateName(newName);
    await withMutationLock(this.profilesRoot, async () => {
      const source = await this.get(oldName);
      const destination = profilePath(this.profilesRoot, newName);
      if (await pathKind(destination) !== "missing") throw new ProfileError("PROFILE_EXISTS", `Profile already exists: ${newName}`);
      await this.assertInactive(source, options.clearStaleLeases ?? false);
      const token = randomUUID();
      const staging = join(this.profilesRoot, `.pi-profile-rename-${oldName}-${token}`);
      const journal = transactionPath(this.profilesRoot, token);
      const updated = { ...source.metadata, name: newName } satisfies ProfileMetadata;
      await atomicWriteJson(journal, { version: 1, operation: "rename", source: source.root, staging, destination });
      try {
        await rename(source.root, staging);
        await atomicWriteJson(join(staging, MARKER), updated);
        await this.fault?.("rename-before-promotion");
        await rename(staging, destination);
        await rm(journal, { force: true });
      } catch (error) {
        try {
          if (await pathKind(staging) === "directory") {
            await atomicWriteJson(join(staging, MARKER), source.metadata);
            await rename(staging, source.root);
          }
          await rm(journal, { force: true });
        } catch {
          throw new ProfileError("ROLLBACK_FAILED", `Rename recovery is required; data remains at ${source.root} or ${staging}`);
        }
        throw error;
      }
    });
  }

  async remove(name: string, options: { clearStaleLeases?: boolean } = {}): Promise<void> {
    await withMutationLock(this.profilesRoot, async () => {
      const profile = await this.get(name);
      await this.assertInactive(profile, options.clearStaleLeases ?? false);
      await rm(profile.root, { recursive: true, force: false });
    });
  }

  private async assertInactive(profile: Profile, clearStale: boolean): Promise<void> {
    let inspection = await inspectLeases(profile);
    if (inspection.active.length || inspection.ambiguous.length) {
      throw new ProfileError("PROFILE_ACTIVE", `Profile is active or its lifecycle cannot be checked safely: ${profile.metadata.name}`);
    }
    if (inspection.stale.length) {
      if (!clearStale) throw new ProfileError("STALE_LEASES", `Profile has stale leases; confirm cleanup before retrying: ${profile.metadata.name}`);
      await clearStaleLeases(profile);
      inspection = await inspectLeases(profile);
      if (inspection.active.length || inspection.ambiguous.length || inspection.stale.length) {
        throw new ProfileError("PROFILE_ACTIVE", `Profile lease cleanup could not be verified: ${profile.metadata.name}`);
      }
    }
  }

  private async assertNoUncertainJournal(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.profilesRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const journal = entries.find((entry) => entry.startsWith(".pi-profile-journal-") && entry.endsWith(".json"));
    if (journal) throw new ProfileError("RECOVERY_REQUIRED", `Profile transaction recovery is required: ${join(this.profilesRoot, journal)}`);
  }
}
