import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

const exec = promisify(execFile);
const repository = resolve(import.meta.dirname, "..");
let fixture: string;
let home: string;
let fakeBin: string;
let environment: NodeJS.ProcessEnv;

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), "pi-profile-e2e-"));
  home = join(fixture, "home");
  fakeBin = join(fixture, "bin");
  await mkdir(home);
  await mkdir(fakeBin);
  const fakeSource = resolve(repository, "tests/fixtures/fake-pi.mjs");
  if (process.platform === "win32") {
    const bundle = join(fakeBin, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    await mkdir(join(bundle, ".."), { recursive: true });
    await copyFile(fakeSource, bundle);
    await writeFile(join(fakeBin, "pi.cmd"), "@echo off\r\n");
  } else {
    await copyFile(fakeSource, join(fakeBin, "pi"));
    await chmod(join(fakeBin, "pi"), 0o755);
  }
  environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
    OPENAI_API_KEY: "synthetic-parent-key",
    TEST_ORDINARY: "preserved",
  };
});
afterAll(async () => rm(fixture, { recursive: true, force: true }));

const cli = (...args: string[]) => exec(process.execPath, [resolve(repository, "bin/pi-profile.js"), ...args], { cwd: fixture, env: environment });

test("built CLI keeps work and personal roots independent during concurrent launches", async () => {
  const unprofiled = join(home, ".pi", "agent", "settings.json");
  await mkdir(join(unprofiled, ".."), { recursive: true });
  await writeFile(unprofiled, '{"unprofiled":true}\n');
  const before = await readFile(unprofiled, "utf8");

  await cli("create", "work");
  await cli("create", "personal");
  const workCwd = join(fixture, "work cwd");
  const personalCwd = join(fixture, "personal cwd");
  await mkdir(workCwd); await mkdir(personalCwd);
  await cli("config", "work", "--default-cwd", workCwd);
  await cli("config", "personal", "--default-cwd", personalCwd);

  const workCapture = join(fixture, "work.json");
  const personalCapture = join(fixture, "personal.json");
  await Promise.all([
    exec(process.execPath, [resolve(repository, "bin/pi-profile.js"), "work", "--session-dir", "/explicit/work", "--", "work prompt"], { cwd: fixture, env: { ...environment, TEST_CAPTURE: workCapture } }),
    exec(process.execPath, [resolve(repository, "bin/pi-profile.js"), "personal", "--fork", "/explicit/personal.jsonl", "--", "personal prompt"], { cwd: fixture, env: { ...environment, TEST_CAPTURE: personalCapture } }),
  ]);

  const work = JSON.parse(await readFile(workCapture, "utf8"));
  const personal = JSON.parse(await readFile(personalCapture, "utf8"));
  expect(work.root).not.toBe(personal.root);
  expect(work.cwd).toBe(await realpath(workCwd));
  expect(personal.cwd).toBe(await realpath(personalCwd));
  expect(work.argv).toContain("/explicit/work");
  expect(personal.argv).toContain("/explicit/personal.jsonl");
  expect(work.openaiPresent).toBe(false);
  expect(personal.openaiPresent).toBe(false);
  expect(work.ordinary).toBe("preserved");
  expect(await readFile(unprofiled, "utf8")).toBe(before);
});

test("profile-local .env variables reach spawned Pi without weakening credential isolation", async () => {
  await cli("create", "envwork");
  const profileRoot = join(home, ".pi", "profiles", "envwork");
  const dotenv = join(profileRoot, ".env");
  await writeFile(dotenv, "PROFILE_ORDINARY=from-profile-env\nOPENAI_API_KEY=synthetic-profile-openai\n", { mode: 0o600 });
  await chmod(dotenv, 0o600);

  const capture = join(fixture, "envwork.json");
  const result = await exec(process.execPath, [resolve(repository, "bin/pi-profile.js"), "envwork", "--", "prompt"], { cwd: fixture, env: { ...environment, TEST_CAPTURE: capture } });

  const captured = JSON.parse(await readFile(capture, "utf8"));
  expect(captured.profileOrdinary).toBe("from-profile-env");
  expect(captured.openaiPresent).toBe(true);
  // The parent's stripped OPENAI_API_KEY is replaced by the profile-owned value, without --inherit.
  expect(captured.openaiValue).toBe("synthetic-profile-openai");
  expect(captured.root).toBe(profileRoot);
  expect(captured.profile).toBe("envwork");
  expect(result.stdout).not.toContain("synthetic-profile-openai");
  expect(result.stderr).not.toContain("synthetic-profile-openai");
});

test("an insecure profile .env fails the launch without leaking secret values", async () => {
  await cli("create", "insecure");
  const dotenv = join(home, ".pi", "profiles", "insecure", ".env");
  await writeFile(dotenv, "OPENAI_API_KEY=synthetic-should-not-load\n", { mode: 0o644 });
  await chmod(dotenv, 0o644);

  const capture = join(fixture, "insecure.json");
  let failure: (Error & { code?: number; stdout?: string; stderr?: string }) | undefined;
  try {
    await exec(process.execPath, [resolve(repository, "bin/pi-profile.js"), "insecure", "--", "prompt"], { cwd: fixture, env: { ...environment, TEST_CAPTURE: capture } });
  } catch (error) {
    failure = error as Error & { code?: number; stdout?: string; stderr?: string };
  }
  expect(failure).toBeDefined();
  expect(failure?.code).not.toBe(0);
  const combined = `${failure?.stdout ?? ""}${failure?.stderr ?? ""}`;
  expect(combined).toContain(".env");
  expect(combined).toMatch(/chmod 600|group|world|permission/i);
  expect(combined).not.toContain("synthetic-should-not-load");
  await expect(readFile(capture, "utf8")).rejects.toBeDefined();
});
