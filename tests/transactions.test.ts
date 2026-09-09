import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { atomicWriteJson, recoverMutationLock, withMutationLock } from "../src/transactions.js";

const fixtures: string[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

test("mutation lock serializes concurrent changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-profile-lock-"));
  fixtures.push(root);
  let active = 0;
  let maximumActive = 0;
  const operation = () => withMutationLock(root, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
  });
  await Promise.all([operation(), operation()]);
  expect(maximumActive).toBe(1);
});

test("explicit recovery clears only a same-host lock whose owner PID is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-profile-lock-recovery-"));
  fixtures.push(root);
  const lock = join(root, ".pi-profile.lock");
  await writeFile(lock, JSON.stringify({ version: 1, id: "stale", hostname: hostname(), pid: 2147483647, createdAt: "2026-09-09T00:00:00.000Z" }));
  await expect(recoverMutationLock(root)).resolves.toMatchObject({ recovered: true, owner: { id: "stale" } });
  await expect(readFile(lock)).rejects.toThrow();
});

test.each([
  ["live", hostname(), process.pid],
  ["unknown-host", "other-host", 2147483647],
])("explicit recovery refuses %s lock ownership", async (_label, ownerHostname, pid) => {
  const root = await mkdtemp(join(tmpdir(), "pi-profile-lock-recovery-"));
  fixtures.push(root);
  const lock = join(root, ".pi-profile.lock");
  await writeFile(lock, JSON.stringify({ version: 1, id: "unsafe", hostname: ownerHostname, pid, createdAt: "2026-09-09T00:00:00.000Z" }));
  await expect(recoverMutationLock(root)).rejects.toThrow(/cannot.*recover|active/i);
  await expect(readFile(lock, "utf8")).resolves.toContain("unsafe");
});

test("lock release verifies its owner token before unlinking", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-profile-lock-owner-"));
  fixtures.push(root);
  const lock = join(root, ".pi-profile.lock");
  await expect(withMutationLock(root, async () => {
    await writeFile(lock, JSON.stringify({ version: 1, id: "replacement", hostname: hostname(), pid: process.pid, createdAt: new Date().toISOString() }));
  })).rejects.toThrow(/ownership/i);
  await expect(readFile(lock, "utf8")).resolves.toContain("replacement");
});

test("an operation failure remains primary when lock cleanup also fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-profile-lock-errors-"));
  fixtures.push(root);
  const lock = join(root, ".pi-profile.lock");
  const primary = new Error("primary operation failure");
  let caught: unknown;
  try {
    await withMutationLock(root, async () => {
      await writeFile(lock, JSON.stringify({ version: 1, id: "replacement", hostname: hostname(), pid: process.pid, createdAt: new Date().toISOString() }));
      throw primary;
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).cause).toBe(primary);
  expect((caught as Error).message).toMatch(/primary operation failure.*cleanup/i);
  await expect(readFile(lock, "utf8")).resolves.toContain("replacement");
});

test("atomic JSON writes complete metadata with restrictive mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-profile-atomic-"));
  fixtures.push(root);
  const target = join(root, "metadata.json");
  await atomicWriteJson(target, { complete: true });
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ complete: true });
});
