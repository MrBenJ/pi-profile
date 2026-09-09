import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Profile, ProfileMetadata, StoreOptions } from "./contracts.js";
import { ProfileError } from "./contracts.js";
import { inspectLeases, clearStaleLeases } from "./lease.js";
import { parseMetadata, validateName } from "./metadata.js";
import { profilePath } from "./paths.js";
import {
  assertStaleMutationOwner,
  atomicWriteJson,
  parseMutationOwner,
  recoverMutationLock,
  transactionPath,
  withMutationLock,
  type MutationOwner,
} from "./transactions.js";

const MARKER = ".pi-profile.json";
const STAGE_MARKER = ".pi-profile-stage.json";
const JOURNAL_PREFIX = ".pi-profile-journal-";

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

function operationOwner(id = randomUUID()): MutationOwner {
  return { version: 1, id, hostname: hostname(), pid: process.pid, createdAt: new Date().toISOString() };
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
    await mkdir(this.profilesRoot, { recursive: true, mode: 0o700 });
    const destination = profilePath(this.profilesRoot, parsed.name);
    await withMutationLock(this.profilesRoot, async () => {
      await this.assertNoUncertainJournalUnlocked();
      if (await pathKind(destination) !== "missing") throw new ProfileError("PROFILE_EXISTS", `Profile already exists: ${parsed.name}`);
    });

    const owner = operationOwner();
    const staging = join(this.profilesRoot, `.pi-profile-create-${parsed.name}-${owner.id}`);
    await mkdir(staging, { mode: 0o700 });
    await atomicWriteJson(join(staging, STAGE_MARKER), owner);
    let published = false;
    try {
      await populate(staging);
      await atomicWriteJson(join(staging, MARKER), parsed);
      return await withMutationLock(this.profilesRoot, async () => {
        await this.assertNoUncertainJournalUnlocked();
        if (await pathKind(destination) !== "missing") throw new ProfileError("PROFILE_EXISTS", `Profile already exists: ${parsed.name}`);
        const journal = transactionPath(this.profilesRoot, owner.id);
        await atomicWriteJson(journal, { ...owner, operation: "create", staging, destination });
        try {
          await this.fault?.("create-before-promotion");
          await rename(staging, destination);
          published = true;
          await rm(join(destination, STAGE_MARKER), { force: true });
          await rm(journal, { force: true });
          return { root: destination, metadata: parsed };
        } catch (error) {
          await rm(journal, { force: true }).catch(() => undefined);
          throw error;
        }
      });
    } finally {
      if (!published) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async list(): Promise<Profile[]> {
    try {
      return await withMutationLock(this.profilesRoot, async () => {
        await this.assertNoUncertainJournalUnlocked();
        return this.listUnlocked();
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async listUnlocked(): Promise<Profile[]> {
    const entries = await readdir(this.profilesRoot, { withFileTypes: true });
    const profiles: Profile[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        profiles.push(await this.getUnlocked(entry.name));
      } catch (error) {
        if (error instanceof ProfileError && error.code === "INVALID_NAME") continue;
        throw error;
      }
    }
    return profiles.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  }

  async get(name: string): Promise<Profile> {
    validateName(name);
    return withMutationLock(this.profilesRoot, async () => {
      await this.assertNoUncertainJournalUnlocked();
      return this.getUnlocked(name);
    });
  }

  private async getUnlocked(name: string): Promise<Profile> {
    validateName(name);
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

  async update(name: string, transform: (current: ProfileMetadata) => ProfileMetadata): Promise<void> {
    validateName(name);
    await withMutationLock(this.profilesRoot, async () => {
      await this.assertNoUncertainJournalUnlocked();
      const profile = await this.getUnlocked(name);
      const parsed = parseMetadata(transform(profile.metadata));
      if (parsed.name !== name) throw new ProfileError("PROFILE_MISMATCH", "Updated metadata name must match the profile");
      const leases = await inspectLeases(profile);
      if (leases.active.length || leases.ambiguous.length) {
        throw new ProfileError("PROFILE_ACTIVE", `Profile is active or its lifecycle cannot be checked safely: ${profile.metadata.name}`);
      }
      await atomicWriteJson(join(profile.root, MARKER), parsed);
    });
  }

  async rename(oldName: string, newName: string, options: { clearStaleLeases?: boolean } = {}): Promise<void> {
    validateName(oldName);
    validateName(newName);
    await withMutationLock(this.profilesRoot, async () => {
      await this.assertNoUncertainJournalUnlocked();
      const source = await this.getUnlocked(oldName);
      const destination = profilePath(this.profilesRoot, newName);
      if (await pathKind(destination) !== "missing") throw new ProfileError("PROFILE_EXISTS", `Profile already exists: ${newName}`);
      await this.assertInactive(source, options.clearStaleLeases ?? false);
      const owner = operationOwner();
      const staging = join(this.profilesRoot, `.pi-profile-rename-${oldName}-${owner.id}`);
      const journal = transactionPath(this.profilesRoot, owner.id);
      const updated = { ...source.metadata, name: newName } satisfies ProfileMetadata;
      await atomicWriteJson(journal, { ...owner, operation: "rename", source: source.root, staging, destination, originalMetadata: source.metadata });
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
      await this.assertNoUncertainJournalUnlocked();
      const profile = await this.getUnlocked(name);
      await this.assertInactive(profile, options.clearStaleLeases ?? false);
      await rm(profile.root, { recursive: true, force: false });
    });
  }

  async recover(): Promise<{ lockRecovered: boolean; transactionsRecovered: number; stagesRecovered: number }> {
    const lock = await recoverMutationLock(this.profilesRoot);
    return withMutationLock(this.profilesRoot, async () => {
      let transactionsRecovered = 0;
      const referencedStages = new Set<string>();
      const entries = await readdir(this.profilesRoot);
      for (const entry of entries.filter((name) => name.startsWith(JOURNAL_PREFIX) && name.endsWith(".json"))) {
        const journalPath = join(this.profilesRoot, entry);
        let journal: Record<string, unknown>;
        try {
          journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
        } catch {
          throw new ProfileError("RECOVERY_REQUIRED", `Cannot parse transaction journal: ${journalPath}`);
        }
        const owner = parseMutationOwner(journal, journalPath);
        assertStaleMutationOwner(owner, `transaction journal ${journalPath}`);
        if (journal.operation !== "create" || typeof journal.staging !== "string" || typeof journal.destination !== "string") {
          throw new ProfileError("RECOVERY_REQUIRED", `Transaction requires manual recovery: ${journalPath}`);
        }
        this.assertOwnedChild(journal.staging, `.pi-profile-create-`, "staging directory");
        this.assertOwnedChild(journal.destination, undefined, "destination");
        referencedStages.add(journal.staging);
        const stageKind = await pathKind(journal.staging);
        const destinationKind = await pathKind(journal.destination);
        if (stageKind === "directory" && destinationKind === "missing") {
          await this.verifyStageOwner(journal.staging, owner);
          await rm(journal.staging, { recursive: true });
        } else if (stageKind === "missing" && destinationKind === "directory") {
          await this.verifyStageOwner(journal.destination, owner);
          await rm(join(journal.destination, STAGE_MARKER), { force: true });
        } else if (!(stageKind === "missing" && destinationKind === "missing")) {
          throw new ProfileError("RECOVERY_REQUIRED", `Transaction paths are ambiguous; inspect ${journalPath}`);
        }
        await rm(journalPath);
        transactionsRecovered += 1;
      }

      let stagesRecovered = 0;
      for (const entry of await readdir(this.profilesRoot)) {
        if (!entry.startsWith(".pi-profile-create-")) continue;
        const stage = join(this.profilesRoot, entry);
        if (referencedStages.has(stage) || await pathKind(stage) !== "directory") continue;
        const owner = parseMutationOwner(JSON.parse(await readFile(join(stage, STAGE_MARKER), "utf8")), stage);
        assertStaleMutationOwner(owner, `staging directory ${stage}`);
        await this.verifyStageOwner(stage, owner);
        await rm(stage, { recursive: true });
        stagesRecovered += 1;
      }
      return { lockRecovered: lock.recovered, transactionsRecovered, stagesRecovered };
    });
  }

  private assertOwnedChild(path: string, requiredPrefix: string | undefined, label: string): void {
    if (dirname(path) !== this.profilesRoot || (requiredPrefix && !basename(path).startsWith(requiredPrefix))) {
      throw new ProfileError("RECOVERY_REQUIRED", `Unsafe ${label} in transaction journal: ${path}`);
    }
  }

  private async verifyStageOwner(stage: string, owner: MutationOwner): Promise<void> {
    let marker: MutationOwner;
    try {
      marker = parseMutationOwner(JSON.parse(await readFile(join(stage, STAGE_MARKER), "utf8")), stage);
    } catch {
      throw new ProfileError("RECOVERY_REQUIRED", `Cannot verify owned staging directory: ${stage}`);
    }
    if (marker.id !== owner.id || marker.hostname !== owner.hostname || marker.pid !== owner.pid) {
      throw new ProfileError("RECOVERY_REQUIRED", `Staging owner does not match transaction owner: ${stage}`);
    }
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

  private async assertNoUncertainJournalUnlocked(): Promise<void> {
    const entries = await readdir(this.profilesRoot);
    const journal = entries.find((entry) => entry.startsWith(JOURNAL_PREFIX) && entry.endsWith(".json"));
    if (journal) throw new ProfileError("RECOVERY_REQUIRED", `Profile transaction recovery is required: ${join(this.profilesRoot, journal)}. Run pi-profile recover after verifying the original process exited.`);
  }
}
