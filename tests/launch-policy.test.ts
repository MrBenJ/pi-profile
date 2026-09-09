import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { classifyInvocation, selectWorkingDirectory, validateLaunch } from "../src/launch-policy.js";
import type { Profile } from "../src/contracts.js";

const fixtures: string[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const profile = (root: string, defaultCwd: string | null = null): Profile => ({
  root,
  metadata: { version: 1, name: "work", defaultCwd, inheritEnvironment: [], createdAt: "2026-09-09T00:00:00.000Z" },
});

test("working directory precedence is CLI, profile default, then caller", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-profile-policy-"));
  fixtures.push(root);
  const cli = join(root, "cli"); const configured = join(root, "configured"); const caller = join(root, "caller");
  await Promise.all([mkdir(cli), mkdir(configured), mkdir(caller)]);
  expect(await selectWorkingDirectory(profile(root, configured), cli, caller)).toBe(cli);
  expect(await selectWorkingDirectory(profile(root, configured), undefined, caller)).toBe(configured);
  expect(await selectWorkingDirectory(profile(root), undefined, caller)).toBe(caller);
});

test("rejects missing or non-directory working directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-profile-policy-"));
  fixtures.push(root);
  const file = join(root, "file"); await writeFile(file, "x");
  await expect(selectWorkingDirectory(profile(root), file, root)).rejects.toThrow();
  await expect(selectWorkingDirectory(profile(root), join(root, "missing"), root)).rejects.toThrow();
});

test.each([
  [["config"], "management"],
  [["install", "npm:thing"], "management"],
  [["remove", "npm:thing"], "management"],
  [["uninstall", "npm:thing"], "management"],
  [["update", "--all"], "management"],
  [["list"], "management"],
  [["auth", "status"], "management"],
  [["--offline", "auth", "--help"], "management"],
  [["--provider", "auth", "hello"], "session"],
  [["-p", "auth"], "session"],
  [["--mode", "json", "hello"], "session"],
  [["--", "auth"], "session"],
] as const)("classifies %j as %s", (args, expected) => expect(classifyInvocation([...args])).toBe(expected));

test("launch validation leaves native session and resource arguments untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-profile-policy-"));
  fixtures.push(root);
  const request = { profile: profile(root), cwd: root, env: {}, piArgs: ["--session-dir", "/other/sessions", "--session", "/other/a.jsonl", "--fork", "/other/b.jsonl", "--", "- literal"] };
  await expect(validateLaunch(request)).resolves.toBeUndefined();
  expect(request.piArgs).toEqual(["--session-dir", "/other/sessions", "--session", "/other/a.jsonl", "--fork", "/other/b.jsonl", "--", "- literal"]);
});
