import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { acquireLease, inspectLeases } from "../src/lease.js";
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

test("live child remains active even if launcher identity is absent", async () => {
  const leases = join(profile.root, ".pi-profile-leases");
  await mkdir(leases, { mode: 0o700 });
  await writeFile(join(leases, "child.json"), JSON.stringify({ version: 1, id: "child", hostname: hostname(), launcherPid: 2147483647, childPid: process.pid, createdAt: new Date().toISOString(), state: "running" }));
  expect((await inspectLeases(profile)).active).toHaveLength(1);
});

test("unknown-host and interrupted startup leases are ambiguous", async () => {
  const leases = join(profile.root, ".pi-profile-leases");
  await mkdir(leases, { mode: 0o700 });
  await writeFile(join(leases, "remote.json"), JSON.stringify({ version: 1, id: "remote", hostname: "another-host", launcherPid: 1, childPid: null, createdAt: new Date().toISOString(), state: "starting" }));
  const result = await inspectLeases(profile);
  expect(result.ambiguous).toHaveLength(1);
});
