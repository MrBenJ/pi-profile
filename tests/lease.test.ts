import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { acquireLease, clearStaleLeases, inspectLeases } from "../src/lease.js";
import type { Profile } from "../src/contracts.js";

let fixture: string;
let profile: Profile;
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "pi-profile-lease-"));
  profile = { root: join(fixture, "work"), metadata: { version: 1, name: "work", defaultCwd: null, inheritEnvironment: [], createdAt: "2026-09-09T00:00:00.000Z" } };
  await mkdir(profile.root);
});
afterEach(async () => rm(fixture, { recursive: true, force: true }));

test("lease records launcher and child and releases only itself", async () => {
  const first = await acquireLease(profile);
  const second = await acquireLease(profile);
  await first.setChild(process.pid);
  expect((await inspectLeases(profile)).active).toHaveLength(2);
  await first.release();
  expect((await inspectLeases(profile)).active).toHaveLength(1);
  await second.release();
});

test("release refuses to erase a changed lease record", async () => {
  const owner = await acquireLease(profile);
  const path = join(profile.root, ".pi-profile-leases", `${owner.lease.id}.json`);
  const replacement = { ...owner.lease, childPid: process.pid, state: "running" };
  await writeFile(path, JSON.stringify(replacement));
  await expect(owner.release()).rejects.toMatchObject({ code: "LEASE_OWNERSHIP_LOST" });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(replacement);
});

test("setChild after release reports lease lifecycle state", async () => {
  const owner = await acquireLease(profile);
  await owner.release();
  await expect(owner.setChild(process.pid)).rejects.toMatchObject({ code: "LEASE_RELEASED" });
});

test("rejects traversal lease IDs without touching an outside sentinel", async () => {
  const leases = join(profile.root, ".pi-profile-leases");
  const outside = join(fixture, "agent", "auth.json");
  await mkdir(join(outside, ".."), { recursive: true });
  await mkdir(leases, { mode: 0o700 });
  await writeFile(outside, "sentinel");
  await writeFile(join(leases, "evil.json"), JSON.stringify({ version: 1, id: "../../../agent/auth", hostname: hostname(), launcherPid: 2147483647, childPid: null, createdAt: new Date().toISOString(), state: "exited" }));
  await expect(clearStaleLeases(profile)).rejects.toMatchObject({ code: "INVALID_LEASE" });
  expect(await readFile(outside, "utf8")).toBe("sentinel");
});

test("filename-id mismatch cannot delete another live lease", async () => {
  const leases = join(profile.root, ".pi-profile-leases");
  await mkdir(leases, { mode: 0o700 });
  const live = { version: 1, id: "live", hostname: hostname(), launcherPid: process.pid, childPid: null, createdAt: new Date().toISOString(), state: "running" };
  await writeFile(join(leases, "live.json"), JSON.stringify(live));
  await writeFile(join(leases, "stale-file.json"), JSON.stringify({ ...live, launcherPid: 2147483647, state: "exited" }));
  await expect(clearStaleLeases(profile)).rejects.toMatchObject({ code: "INVALID_LEASE" });
  expect(JSON.parse(await readFile(join(leases, "live.json"), "utf8"))).toEqual(live);
});

test("stale cleanup restores evidence changed after inspection", async () => {
  const leases = join(profile.root, ".pi-profile-leases");
  await mkdir(leases, { mode: 0o700 });
  const path = join(leases, "stale.json");
  const stale = { version: 1, id: "stale", hostname: hostname(), launcherPid: 2147483647, childPid: null, createdAt: new Date().toISOString(), state: "exited" };
  const changed = { ...stale, launcherPid: process.pid, state: "running" };
  await writeFile(path, JSON.stringify(stale));
  await expect(clearStaleLeases(profile, { beforeRemove: async () => writeFile(path, JSON.stringify(changed)) })).rejects.toMatchObject({ code: "LEASE_CHANGED" });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(changed);
});

test("live child remains active even if launcher identity is absent", async () => {
  const leases = join(profile.root, ".pi-profile-leases");
  await mkdir(leases, { mode: 0o700 });
  await writeFile(join(leases, "child.json"), JSON.stringify({ version: 1, id: "child", hostname: hostname(), launcherPid: 2147483647, childPid: process.pid, createdAt: new Date().toISOString(), state: "running" }));
  expect((await inspectLeases(profile)).active).toHaveLength(1);
});

test.each([
  [0, null],
  [-1, null],
  [Number.MAX_SAFE_INTEGER + 1, null],
  [1, 0],
  [1, -1],
  [1, Number.MAX_SAFE_INTEGER + 1],
])("rejects unsafe launcherPid %s and childPid %s", async (launcherPid, childPid) => {
  const leases = join(profile.root, ".pi-profile-leases");
  await mkdir(leases, { mode: 0o700 });
  await writeFile(join(leases, "invalid.json"), JSON.stringify({ version: 1, id: "invalid", hostname: hostname(), launcherPid, childPid, createdAt: new Date().toISOString(), state: "running" }));
  await expect(inspectLeases(profile)).rejects.toMatchObject({ code: "INVALID_LEASE" });
});

test("unknown-host and interrupted startup leases are ambiguous", async () => {
  const leases = join(profile.root, ".pi-profile-leases");
  await mkdir(leases, { mode: 0o700 });
  await writeFile(join(leases, "remote.json"), JSON.stringify({ version: 1, id: "remote", hostname: "another-host", launcherPid: 1, childPid: null, createdAt: new Date().toISOString(), state: "starting" }));
  const result = await inspectLeases(profile);
  expect(result.ambiguous).toHaveLength(1);
});
