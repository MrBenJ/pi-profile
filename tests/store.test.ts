import { lstat, mkdir, readFile, readdir, rm as removePath, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { ProfileStore } from "../src/profile-store.js";
import { acquireLease } from "../src/lease.js";
import { withMutationLock } from "../src/transactions.js";

let fixture: string;
let profilesRoot: string;
let store: ProfileStore;
const now = () => new Date("2026-09-09T00:00:00.000Z");

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "pi-profile-store-"));
  profilesRoot = join(fixture, "profiles");
  store = new ProfileStore({ profilesRoot, now });
});
afterEach(async () => rm(fixture, { recursive: true, force: true }));

const metadata = (name: string) => ({ version: 1 as const, name, defaultCwd: null, inheritEnvironment: [], createdAt: now().toISOString() });

describe("ProfileStore", () => {
  test("creates, gets, and lists profiles in lexical order", async () => {
    await store.create(metadata("work"));
    await store.create(metadata("personal"));
    expect((await store.list()).map((profile) => profile.metadata.name)).toEqual(["personal", "work"]);
    expect((await store.get("work")).root).toBe(join(profilesRoot, "work"));
  });

  test("uses restrictive POSIX modes", async () => {
    const profile = await store.create(metadata("work"));
    if (process.platform !== "win32") {
      expect((await lstat(profile.root)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(profile.root, ".pi-profile.json"))).mode & 0o777).toBe(0o600);
    }
  });

  test("rejects invalid, colliding, and symlinked profiles or markers", async () => {
    await store.create(metadata("work"));
    await expect(store.create(metadata("work"))).rejects.toThrow();
    await mkdir(join(profilesRoot, "bad"));
    await writeFile(join(profilesRoot, "bad", ".pi-profile.json"), "{}");
    await expect(store.get("bad")).rejects.toThrow();
    await symlink(join(profilesRoot, "work"), join(profilesRoot, "linked"), "dir");
    await expect(store.get("linked")).rejects.toThrow();
    await mkdir(join(profilesRoot, "other"));
    await symlink(join(profilesRoot, "work", ".pi-profile.json"), join(profilesRoot, "other", ".pi-profile.json"));
    await expect(store.get("other")).rejects.toThrow();
  });

  test("updates and renames metadata without collision", async () => {
    await store.create(metadata("work"));
    await store.update("work", (current) => ({ ...current, defaultCwd: fixture }));
    expect((await store.get("work")).metadata.defaultCwd).toBe(fixture);
    await store.rename("work", "office");
    expect((await store.get("office")).metadata.name).toBe("office");
    await expect(store.get("work")).rejects.toThrow();
  });

  test("blocks rename and removal while a launcher or child is live", async () => {
    const profile = await store.create(metadata("work"));
    const lease = await acquireLease(profile);
    await lease.setChild(process.pid);
    await expect(store.remove("work")).rejects.toThrow(/active/i);
    await expect(store.rename("work", "office")).rejects.toThrow(/active/i);
    await lease.release();
    await store.remove("work");
    await expect(store.get("work")).rejects.toThrow();
  });

  test("reads wait for a healthy in-flight transaction instead of reporting recovery", async () => {
    await store.create(metadata("work"));
    let started!: () => void;
    let finish!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const finishPromise = new Promise<void>((resolve) => { finish = resolve; });
    const journal = join(profilesRoot, ".pi-profile-journal-healthy.json");
    const mutation = withMutationLock(profilesRoot, async () => {
      await writeFile(journal, "{}");
      started();
      await finishPromise;
      await removePath(journal);
    });
    await startedPromise;
    const read = store.list();
    await new Promise((resolve) => setTimeout(resolve, 50));
    finish();
    await mutation;
    await expect(read).resolves.toHaveLength(1);
  });

  test("explicit recovery cleans an interrupted same-host import and its stale lock", async () => {
    await mkdir(profilesRoot, { recursive: true });
    const token = "interrupted";
    const staging = join(profilesRoot, `.pi-profile-create-personal-${token}`);
    const destination = join(profilesRoot, "personal");
    await mkdir(staging);
    const owner = { version: 1, id: token, hostname: hostname(), pid: 2147483647, createdAt: "2026-09-09T00:00:00.000Z" };
    await writeFile(join(staging, ".pi-profile-stage.json"), JSON.stringify(owner));
    await writeFile(join(staging, "auth.json"), "opaque-synthetic");
    await writeFile(join(profilesRoot, ".pi-profile.lock"), JSON.stringify(owner));
    await writeFile(join(profilesRoot, `.pi-profile-journal-${token}.json`), JSON.stringify({ ...owner, operation: "create", staging, destination }));
    await expect(store.recover()).resolves.toMatchObject({ lockRecovered: true, transactionsRecovered: 1 });
    await expect(readFile(join(staging, "auth.json"))).rejects.toThrow();
    await expect(store.list()).resolves.toEqual([]);
  });

  test.each([
    ["source", "work"],
    ["staging", "work"],
    ["destination", "office"],
  ] as const)("recovers deterministic rename crash window with only %s present", async (present, expectedName) => {
    await mkdir(profilesRoot, { recursive: true });
    const token = `rename-${present}`;
    const owner = { version: 1 as const, id: token, hostname: hostname(), pid: 2147483647, createdAt: now().toISOString() };
    const original = metadata("work");
    const updated = { ...original, name: "office" };
    const sourcePath = join(profilesRoot, "work");
    const staging = join(profilesRoot, `.pi-profile-rename-work-${token}`);
    const destination = join(profilesRoot, "office");
    const existing = present === "source" ? sourcePath : present === "staging" ? staging : destination;
    await mkdir(existing);
    await writeFile(join(existing, ".pi-profile.json"), JSON.stringify(updated));
    const journal = join(profilesRoot, `.pi-profile-journal-${token}.json`);
    await writeFile(journal, JSON.stringify({ ...owner, operation: "rename", source: sourcePath, staging, destination, originalMetadata: original }));

    await expect(store.recover()).resolves.toMatchObject({ transactionsRecovered: 1 });
    expect((await store.list()).map((profile) => profile.metadata.name)).toEqual([expectedName]);
    if (expectedName === "work") expect((await store.get("work")).metadata).toEqual(original);
    await expect(readFile(journal)).rejects.toThrow();
  });

  test("rename recovery refuses ambiguous collisions without modifying either profile", async () => {
    await mkdir(profilesRoot, { recursive: true });
    const token = "rename-ambiguous";
    const owner = { version: 1 as const, id: token, hostname: hostname(), pid: 2147483647, createdAt: now().toISOString() };
    const original = metadata("work");
    const sourcePath = join(profilesRoot, "work");
    const destination = join(profilesRoot, "office");
    const staging = join(profilesRoot, `.pi-profile-rename-work-${token}`);
    for (const [path, value] of [[sourcePath, original], [destination, { ...original, name: "office" }]] as const) {
      await mkdir(path);
      await writeFile(join(path, ".pi-profile.json"), JSON.stringify(value));
    }
    const journal = join(profilesRoot, `.pi-profile-journal-${token}.json`);
    await writeFile(journal, JSON.stringify({ ...owner, operation: "rename", source: sourcePath, staging, destination, originalMetadata: original }));
    await expect(store.recover()).rejects.toThrow(/ambiguous/i);
    expect(JSON.parse(await readFile(join(sourcePath, ".pi-profile.json"), "utf8"))).toEqual(original);
    expect(JSON.parse(await readFile(join(destination, ".pi-profile.json"), "utf8"))).toEqual({ ...original, name: "office" });
    await expect(readFile(journal)).resolves.toBeTruthy();
  });

  test("rename recovery validates owned paths before writing", async () => {
    const profile = await store.create(metadata("work"));
    const outside = join(fixture, "outside");
    await mkdir(outside);
    await writeFile(join(outside, ".pi-profile.json"), "untouched");
    const token = "rename-tampered";
    const owner = { version: 1 as const, id: token, hostname: hostname(), pid: 2147483647, createdAt: now().toISOString() };
    const journal = join(profilesRoot, `.pi-profile-journal-${token}.json`);
    await writeFile(journal, JSON.stringify({ ...owner, operation: "rename", source: profile.root, staging: outside, destination: join(profilesRoot, "office"), originalMetadata: metadata("work") }));
    await expect(store.recover()).rejects.toThrow(/unsafe|manual recovery/i);
    expect(await readFile(join(outside, ".pi-profile.json"), "utf8")).toBe("untouched");
    expect(JSON.parse(await readFile(join(profile.root, ".pi-profile.json"), "utf8"))).toEqual(metadata("work"));
  });

  test("orphan staging without an owner marker raises an actionable typed error", async () => {
    await mkdir(join(profilesRoot, ".pi-profile-create-work-orphan"), { recursive: true });
    await expect(store.recover()).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(store.recover()).rejects.toThrow(/owner marker|verify owned staging/i);
  });

  test("concurrent creates publish only one profile", async () => {
    const results = await Promise.allSettled([store.create(metadata("work")), store.create(metadata("work"))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await store.list()).toHaveLength(1);
  });

  test("launch acquisition racing removal cannot recreate a removed profile", async () => {
    const profile = await store.create(metadata("work"));
    const results = await Promise.allSettled([acquireLease(profile), store.remove("work")]);
    const acquired = results[0];
    if (acquired.status === "fulfilled") {
      await expect(store.get("work")).resolves.toBeDefined();
      await acquired.value.release();
    } else {
      await expect(store.get("work")).rejects.toThrow();
    }
  });

  test("injected create promotion failure removes only owned staging", async () => {
    const failing = new ProfileStore({ profilesRoot, now, fault: (point) => {
      if (point === "create-before-promotion") throw new Error("injected");
    } });
    await expect(failing.create(metadata("work"))).rejects.toThrow("injected");
    expect(await store.list()).toEqual([]);
    expect((await readdir(profilesRoot)).filter((entry) => entry.includes("create-work"))).toEqual([]);
  });

  test("removal does not traverse symlinks", async () => {
    const outside = join(fixture, "outside.txt");
    await writeFile(outside, "keep");
    const profile = await store.create(metadata("work"));
    await symlink(outside, join(profile.root, "outside-link"));
    await store.remove("work");
    expect(await readFile(outside, "utf8")).toBe("keep");
  });
});
