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
        await atomicWriteJson(journal, { ...owner, operation: "create", staging, destination, metadata: parsed });
        let committed = false;
        try {
          await this.fault?.("create-before-promotion");
          await rename(staging, destination);
          committed = true;
          published = true;
          try {
            await this.fault?.("create-after-promotion");
            await rm(join(destination, STAGE_MARKER), { force: true });
            await rm(journal, { force: true });
          } catch (error) {
            throw new ProfileError(
              "CREATE_COMMITTED_CLEANUP_PENDING",
              `Profile ${parsed.name} was created at ${destination}, but transaction cleanup is pending; run pi-profile recover (${(error as Error).message})`,
            );
          }
          return { root: destination, metadata: parsed };
        } catch (error) {
          if (!committed) await rm(journal, { force: true }).catch(() => undefined);
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
      let committed = false;
      try {
        await rename(source.root, staging);
        await atomicWriteJson(join(staging, MARKER), updated);
        await this.fault?.("rename-before-promotion");
        await rename(staging, destination);
        committed = true;
        try {
          await this.fault?.("rename-after-promotion");
          await rm(journal, { force: true });
        } catch (error) {
          throw new ProfileError(
            "RENAME_COMMITTED_CLEANUP_PENDING",
            `Rename committed at destination ${destination}, but journal cleanup is pending. Source candidate: ${source.root}; staging candidate: ${staging}; run pi-profile recover after this process exits (${(error as Error).message})`,
          );
        }
      } catch (error) {
        if (committed) throw error;
        try {
          if (await pathKind(staging) === "directory") {
            await atomicWriteJson(join(staging, MARKER), source.metadata);
            await rename(staging, source.root);
          }
          await rm(journal, { force: true });
        } catch {
          throw new ProfileError("ROLLBACK_FAILED", `Rename recovery is required. Source: ${source.root}; staging: ${staging}; destination: ${destination}`);
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
      const entries = await readdir(this.profilesRoot);
      const recoveries: Array<
        | { operation: "create"; journalPath: string; owner: MutationOwner; staging: string; destination: string; metadata?: ProfileMetadata }
        | { operation: "rename"; journalPath: string; owner: MutationOwner; source: string; staging: string; destination: string; original: ProfileMetadata; updated: ProfileMetadata }
      > = [];

      // Validate every journal and every path before mutating any transaction state.
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
        if (entry !== `${JOURNAL_PREFIX}${owner.id}.json`) {
          throw new ProfileError("RECOVERY_REQUIRED", `Transaction journal filename does not match its owner: ${journalPath}`);
        }
        if (typeof journal.staging !== "string" || typeof journal.destination !== "string") {
          throw new ProfileError("RECOVERY_REQUIRED", `Transaction paths are missing: ${journalPath}`);
        }
        this.assertOwnedChild(journal.destination, undefined, "destination");
        const destinationName = validateName(basename(journal.destination));

        if (journal.operation === "create") {
          const expectedStage = join(this.profilesRoot, `.pi-profile-create-${destinationName}-${owner.id}`);
          if (journal.staging !== expectedStage) throw new ProfileError("RECOVERY_REQUIRED", `Unsafe staging directory in transaction journal: ${journal.staging}`);
          let metadata: ProfileMetadata | undefined;
          if (journal.metadata !== undefined) {
            metadata = parseMetadata(journal.metadata);
            if (metadata.name !== destinationName) throw new ProfileError("RECOVERY_REQUIRED", `Create metadata does not match destination: ${journalPath}`);
          }
          recoveries.push({ operation: "create", journalPath, owner, staging: journal.staging, destination: journal.destination, ...(metadata ? { metadata } : {}) });
          continue;
        }

        if (journal.operation === "rename" && typeof journal.source === "string") {
          const original = parseMetadata(journal.originalMetadata);
          const source = profilePath(this.profilesRoot, original.name);
          const expectedStage = join(this.profilesRoot, `.pi-profile-rename-${original.name}-${owner.id}`);
          if (journal.source !== source || journal.staging !== expectedStage || source === journal.destination || destinationName === original.name) {
            throw new ProfileError("RECOVERY_REQUIRED", `Unsafe rename paths in transaction journal: ${journalPath}`);
          }
          recoveries.push({ operation: "rename", journalPath, owner, source, staging: journal.staging, destination: journal.destination, original, updated: { ...original, name: destinationName } });
          continue;
        }
        throw new ProfileError("RECOVERY_REQUIRED", `Unknown transaction operation requires manual recovery: ${journalPath}`);
      }

      const referencedStages = new Set(recoveries.map((recovery) => recovery.staging));
      let transactionsRecovered = 0;
      for (const recovery of recoveries) {
        if (recovery.operation === "create") await this.recoverCreate(recovery);
        else await this.recoverRename(recovery);
        await rm(recovery.journalPath);
        transactionsRecovered += 1;
      }

      let stagesRecovered = 0;
      for (const entry of await readdir(this.profilesRoot)) {
        if (!entry.startsWith(".pi-profile-create-")) continue;
        const stage = join(this.profilesRoot, entry);
        if (referencedStages.has(stage) || await pathKind(stage) !== "directory") continue;
        const owner = await this.readStageOwner(stage);
        assertStaleMutationOwner(owner, `staging directory ${stage}`);
        await rm(stage, { recursive: true });
        stagesRecovered += 1;
      }
      return { lockRecovered: lock.recovered, transactionsRecovered, stagesRecovered };
    });
  }

  private async recoverCreate(recovery: { journalPath: string; owner: MutationOwner; staging: string; destination: string; metadata?: ProfileMetadata }): Promise<void> {
    const stageKind = await pathKind(recovery.staging);
    const destinationKind = await pathKind(recovery.destination);
    if (stageKind === "directory" && destinationKind === "missing") {
      await this.verifyStageOwner(recovery.staging, recovery.owner);
      await rm(recovery.staging, { recursive: true });
      return;
    }
    if (stageKind === "missing" && destinationKind === "directory") {
      if (await pathKind(join(recovery.destination, STAGE_MARKER)) === "file") {
        await this.verifyStageOwner(recovery.destination, recovery.owner);
      } else if (!recovery.metadata) {
        throw new ProfileError("RECOVERY_REQUIRED", `Cannot verify committed create destination: ${recovery.destination}`);
      }
      if (recovery.metadata) await this.assertProfileMetadata(recovery.destination, [recovery.metadata]);
      await rm(join(recovery.destination, STAGE_MARKER), { force: true });
      return;
    }
    throw new ProfileError("RECOVERY_REQUIRED", `Create transaction paths are ambiguous; inspect ${recovery.journalPath}`);
  }

  private async recoverRename(recovery: { journalPath: string; source: string; staging: string; destination: string; original: ProfileMetadata; updated: ProfileMetadata }): Promise<void> {
    const [sourceKind, stageKind, destinationKind] = await Promise.all([
      pathKind(recovery.source), pathKind(recovery.staging), pathKind(recovery.destination),
    ]);
    const directories = [sourceKind, stageKind, destinationKind].filter((kind) => kind === "directory").length;
    if (directories !== 1 || [sourceKind, stageKind, destinationKind].some((kind) => kind !== "directory" && kind !== "missing")) {
      throw new ProfileError("RECOVERY_REQUIRED", `Rename transaction paths are ambiguous; inspect ${recovery.journalPath}`);
    }
    if (sourceKind === "directory") {
      const current = await this.assertProfileMetadata(recovery.source, [recovery.original, recovery.updated]);
      if (!this.sameMetadata(current, recovery.original)) await atomicWriteJson(join(recovery.source, MARKER), recovery.original);
      return;
    }
    if (stageKind === "directory") {
      await this.assertProfileMetadata(recovery.staging, [recovery.original, recovery.updated]);
      await atomicWriteJson(join(recovery.staging, MARKER), recovery.original);
      await rename(recovery.staging, recovery.source);
      return;
    }
    await this.assertProfileMetadata(recovery.destination, [recovery.updated]);
  }

  private sameMetadata(left: ProfileMetadata, right: ProfileMetadata): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private async assertProfileMetadata(root: string, allowed: ProfileMetadata[]): Promise<ProfileMetadata> {
    const marker = join(root, MARKER);
    if (await pathKind(marker) !== "file") throw new ProfileError("RECOVERY_REQUIRED", `Cannot verify profile marker during recovery: ${marker}`);
    let metadata: ProfileMetadata;
    try {
      metadata = parseMetadata(JSON.parse(await readFile(marker, "utf8")));
    } catch {
      throw new ProfileError("RECOVERY_REQUIRED", `Cannot verify profile marker during recovery: ${marker}`);
    }
    if (!allowed.some((candidate) => this.sameMetadata(metadata, candidate))) {
      throw new ProfileError("RECOVERY_REQUIRED", `Profile marker does not match transaction ownership: ${marker}`);
    }
    return metadata;
  }

  private async readStageOwner(stage: string): Promise<MutationOwner> {
    const marker = join(stage, STAGE_MARKER);
    try {
      return parseMutationOwner(JSON.parse(await readFile(marker, "utf8")), marker);
    } catch {
      throw new ProfileError("RECOVERY_REQUIRED", `Cannot verify owned staging directory; owner marker is missing or invalid: ${marker}`);
    }
  }

  private assertOwnedChild(path: string, requiredPrefix: string | undefined, label: string): void {
    if (dirname(path) !== this.profilesRoot || (requiredPrefix && !basename(path).startsWith(requiredPrefix))) {
      throw new ProfileError("RECOVERY_REQUIRED", `Unsafe ${label} in transaction journal: ${path}`);
    }
  }

  private async verifyStageOwner(stage: string, owner: MutationOwner): Promise<void> {
    const marker = await this.readStageOwner(stage);
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
