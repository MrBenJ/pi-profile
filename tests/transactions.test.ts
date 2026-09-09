import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { atomicWriteJson, withMutationLock } from "../src/transactions.js";

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

test("atomic JSON writes complete metadata with restrictive mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-profile-atomic-"));
  fixtures.push(root);
  const target = join(root, "metadata.json");
  await atomicWriteJson(target, { complete: true });
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ complete: true });
});
